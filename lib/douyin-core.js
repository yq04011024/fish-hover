/* ============================================================
 * douyin-core.js — 抖音数据/网络层：
 *   DouyinEntry 归一化模型、DyPersistentWorker 常驻纯 Node 子进程、
 *   DouyinClient API 客户端、DouyinMediaProxy 本地媒体代理。
 * 注意：抖音请求必须走独立子进程（扩展宿主 https 被 patch 会风控空 body）。
 * ============================================================ */
'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { signDouyinUrl } = require('../dy-signer');
const {
	REQUEST_TIMEOUT_MS,
	readConfig,
	stripHighlightTags,
	ensureHttps,
	formatDuration,
	formatCount,
} = require('./shared');

// 抖音接口（GET）：推荐流免签名但必须有登录态 Cookie（无 Cookie 返回 200 空 body）；关注流需 a_bogus 签名 + Cookie
const ENDPOINT_DY_TAB_FEED = 'https://www.douyin.com/aweme/v1/web/tab/feed/';
const ENDPOINT_DY_FOLLOW_FEED = 'https://www.douyin.com/aweme/v1/web/follow/feed/';
const ENDPOINT_DY_SEARCH = 'https://www.douyin.com/aweme/v1/web/general/search/single/';
// 抖音请求须与真实浏览器 UA 一致（a_bogus 签名把 UA 参与摘要，服务端按 UA 校验）
const DY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
// 关注流用 129 UA（签名+请求头一致使用，对齐可用组合）；推荐流用 150
const DY_UA_FOLLOW = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const DY_REFERER = 'https://www.douyin.com';
const DY_FEED_COUNT = 10; // 推荐流每页条数
const DY_FOLLOW_COUNT = 10; // 关注流每页条数
const DY_MAX_LIST_SIZE = 60; // 前端列表上限（超过后丢弃最旧条目，防止内存膨胀）
const DY_PROXY_MAX_REDIRECTS = 5; // 媒体代理手动跟随重定向次数上限

// ---------- 抖音：数据模型 ----------
/**
 * 抖音视频条目（来自推荐流 / 关注流的归一化结果）
 * playUrls 按可用优先级排序：/aweme/v1/play/ mp4 直链 > douyinvod/bytecdn > 其他；
 * 仅剩 m3u8 时 playUrls 为空（一期不支持内播 HLS，前端回退"站外打开"）。
 */
class DouyinEntry {
	constructor({ awemeId, title, author, avatar, cover, playUrls, durationSec, digg, comment, share }) {
		this.awemeId = awemeId || '';
		this.title = title || '（无标题）';
		this.author = author || '抖音作者';
		this.avatar = ensureHttps(avatar);
		this.cover = ensureHttps(cover);
		this.playUrls = playUrls || [];
		this.durationSec = durationSec || 0;
		this.digg = digg || 0;
		this.comment = comment || 0;
		this.share = share || 0;
	}

	get pageUrl() {
		return this.awemeId ? `https://www.douyin.com/video/${this.awemeId}` : '';
	}

	get durationText() {
		return formatDuration(this.durationSec);
	}

	serialize() {
		return {
			awemeId: this.awemeId,
			title: this.title,
			author: this.author,
			avatar: this.avatar,
			cover: this.cover,
			durationText: this.durationText,
			diggText: formatCount(this.digg),
			commentText: formatCount(this.comment),
			shareText: formatCount(this.share),
			pageUrl: this.pageUrl,
		};
	}
}

/** 抖音接口 aweme_item → DouyinEntry（播放地址优先 play_addr_h264，URL 按直链优先级排序） */
function douyinEntryFromAweme(aweme) {
	if (!aweme || !aweme.aweme_id) {
		return null;
	}
	const video = aweme.video || {};
	const urls = [];
	for (const addr of [video.play_addr_h264, video.play_addr]) {
		for (const url of (addr && addr.url_list) || []) {
			if (typeof url === 'string' && url && !urls.includes(url)) {
				urls.push(url);
			}
		}
	}
	const rank = (url) => {
		if (url.includes('/aweme/v1/play/')) {
			return 0; // mp4 直链（CDN 最稳）
		}
		if (/douyinvod\.com|bytecdn|douyinpic/.test(url)) {
			return 1;
		}
		return 2;
	};
	urls.sort((a, b) => rank(a) - rank(b));
	return new DouyinEntry({
		awemeId: aweme.aweme_id,
		title: stripHighlightTags(aweme.desc),
		author: aweme.author && aweme.author.nickname,
		avatar: aweme.author && aweme.author.avatar_thumb && aweme.author.avatar_thumb.url_list && aweme.author.avatar_thumb.url_list[0],
		cover: video.cover && video.cover.url_list && video.cover.url_list[0],
		playUrls: urls,
		durationSec: Math.round((aweme.duration || video.duration || 0) / 1000), // 抖音为毫秒
		digg: aweme.statistics && aweme.statistics.digg_count,
		comment: aweme.statistics && aweme.statistics.comment_count,
		share: aweme.statistics && aweme.statistics.share_count,
	});
}

/** 抖音接口响应统一解析：返回 { entries, hasMore, maxCursor }
 *  推荐流：body.aweme_list[] + body.max_cursor/has_more；
 *  关注流：body.data[]（每项含 aweme 字段）+ body.cursor/has_more（TouchFish 同款结构）
 */
function douyinListFromBody(body) {
	let list = (body && Array.isArray(body.aweme_list) && body.aweme_list) || [];
	let hasMore = Boolean(body && body.has_more);
	let maxCursor = Number((body && body.max_cursor) || 0);
	if (list.length === 0 && body && Array.isArray(body.data)) {
		list = body.data.map((item) => item && item.aweme).filter(Boolean);
		hasMore = Boolean(body.has_more);
		maxCursor = Number(body.cursor || body.max_cursor || 0);
	}
	const entries = list.map(douyinEntryFromAweme).filter(Boolean);
	return { entries, hasMore, maxCursor };
}

// ---------- 抖音：常驻请求子进程 ----------
/**
 * 持久化抖音请求 worker：扩展生命周期内只 spawn 一次纯 Node 子进程，
 * 后续所有请求通过「行分隔 JSON」复用该进程，消除每次请求冷启动 Electron 的数百 ms 开销。
 * 空闲超过 DY_WORKER_IDLE_MS 自动退出释放资源，下次请求自动重启；子进程异常退出时 pending 请求全部失败并允许重启。
 */
const DY_WORKER_IDLE_MS = 4 * 60 * 1000;
const DY_WORKER_STARTUP_MS = 15000;

class DyPersistentWorker {
	constructor() {
		this.child = null;
		this.ready = false;
		this.starting = null; // 启动中的 Promise（去重并发启动）
		this.pending = new Map(); // id → { resolve, reject, timer }
		this.nextId = 1;
		this.idleTimer = null;
		this.stderrText = '';
	}

	/** 确保子进程已启动（并发请求共用同一个启动 Promise） */
	ensureStarted() {
		if (this.ready && this.child) {
			return Promise.resolve();
		}
		if (this.starting) {
			return this.starting;
		}
		this.starting = new Promise((resolve, reject) => {
			// worker 脚本位于扩展根目录（本模块在 lib/ 子目录，需回到上一级）
			const workerPath = path.join(__dirname, '..', 'dy-fetch-worker.js');
			// 清理宿主注入的引导环境变量（NODE_OPTIONS 的 --require 会把网络补丁再次注入子进程）
			const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
			delete env.NODE_OPTIONS;
			delete env.VSCODE_INSPECTOR_OPTIONS;
			delete env.ELECTRON_ENABLE_LOGGING;
			let child;
			try {
				child = spawn(process.execPath, [workerPath], { env, windowsHide: true });
			} catch (error) {
				this.starting = null;
				reject(error);
				return;
			}
			this.child = child;
			this.stderrText = '';
			let outBuffer = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				outBuffer += chunk;
				let boundary;
				// 按行分发响应（worker 每条响应占一行）
				while ((boundary = outBuffer.indexOf('\n')) >= 0) {
					const line = outBuffer.slice(0, boundary).trim();
					outBuffer = outBuffer.slice(boundary + 1);
					if (line) {
						this.dispatch(line);
					}
				}
			});
			child.stderr.on('data', (chunk) => {
				this.stderrText = (this.stderrText + chunk).slice(-1000);
			});
			child.on('error', (error) => {
				if (!this.ready) {
					this.starting = null;
					reject(error);
				}
				this.failAll(error);
			});
			child.on('exit', (code) => {
				const wasReady = this.ready;
				this.child = null;
				this.ready = false;
				this.starting = null;
				clearTimeout(this.idleTimer);
				this.failAll(new Error(`抖音 worker 退出（code ${code}）${wasReady ? '' : '，stderr: ' + this.stderrText.slice(0, 200)}`));
			});
			// 用一次 ping 确认纯 Node 模式与行协议可用
			this.requestRaw({ ping: true }, DY_WORKER_STARTUP_MS)
				.then((result) => {
					this.ready = true;
					this.starting = null;
					console.log('[bili-hover-viewer] 常驻抖音 worker 就绪:', JSON.stringify(result.diag || {}));
					resolve();
				})
				.catch((error) => {
					this.starting = null;
					try { child.kill(); } catch (killError) { /* 忽略 */ }
					reject(error);
				});
		});
		return this.starting;
	}

	/** 分发一行响应到对应 pending 请求 */
	dispatch(line) {
		let result;
		try {
			result = JSON.parse(line);
		} catch (error) {
			console.log('[bili-hover-viewer] worker 响应解析失败:', error.message, line.slice(0, 150));
			return;
		}
		const item = this.pending.get(result.id);
		if (!item) {
			return; // 超时已清理或未知 id
		}
		this.pending.delete(result.id);
		clearTimeout(item.timer);
		if (result.ok) {
			item.resolve(result);
		} else {
			item.reject(new Error(result.error || 'worker 未知错误'));
		}
	}

	/** 子进程退出时拒绝所有未完成请求 */
	failAll(error) {
		for (const item of this.pending.values()) {
			clearTimeout(item.timer);
			item.reject(error);
		}
		this.pending.clear();
	}

	/** 写一行请求并等待对应 id 的响应 */
	requestRaw(payload, timeoutMs) {
		const id = this.nextId++;
		payload.id = id;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`worker 请求超时（${timeoutMs}ms）`));
				}
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.child.stdin.write(JSON.stringify(payload) + '\n');
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	/** 对外请求入口：保证进程存活 → 发送 → 刷新空闲计时 */
	async request(payload, timeoutMs) {
		clearTimeout(this.idleTimer);
		await this.ensureStarted();
		try {
			return await this.requestRaw(payload, timeoutMs || REQUEST_TIMEOUT_MS);
		} finally {
			this.scheduleIdleExit();
		}
	}

	/** 空闲计时：无请求一段时间后优雅退出，下次请求自动冷启动 */
	scheduleIdleExit() {
		clearTimeout(this.idleTimer);
		if (!this.child) {
			return;
		}
		this.idleTimer = setTimeout(() => {
			if (this.pending.size === 0 && this.child) {
				try {
					this.child.stdin.write(JSON.stringify({ id: 0, shutdown: true }) + '\n');
				} catch (error) {
					try { this.child.kill(); } catch (killError) { /* 忽略 */ }
				}
			}
		}, DY_WORKER_IDLE_MS);
	}

	/** 扩展停用时释放进程 */
	stop() {
		clearTimeout(this.idleTimer);
		if (this.child) {
			try { this.child.kill(); } catch (error) { /* 忽略 */ }
			this.child = null;
		}
		this.ready = false;
	}
}

// 模块级单例：DouyinClient 与 DouyinMediaProxy 共用同一个常驻 worker
const dyWorker = new DyPersistentWorker();

// ---------- 抖音：数据客户端 ----------
class DouyinClient {
	/** Cookie 清洗：去除换行等非法头字符（浏览器复制的 Cookie 偶尔带换行，会导致请求头构造抛错） */
	static cleanCookie(raw) {
		return String(raw || '').replace(/[\r\n]+/g, '').trim();
	}

	get userCookie() {
		return DouyinClient.cleanCookie(readConfig('douyinCookie', ''));
	}

	/**
	 * 抖音请求头（对齐可用组合的头集合与顺序：Cookie, User-Agent, Referer, Origin + Accept 系）；
	 * overrides 供各接口覆盖 UA/Referer（签名 UA 必须与请求 UA 一致）
	 */
	buildRequestHeaders(overrides) {
		const headers = {
			...(this.userCookie ? { Cookie: this.userCookie } : {}),
			'User-Agent': DY_UA,
			Referer: DY_REFERER,
			Origin: DY_REFERER,
			...(overrides || {}),
		};
		// axios（参考实现所用 HTTP 库）node 端默认头
		if (!headers.Accept) {
			headers.Accept = 'application/json, text/plain, */*';
		}
		if (!headers['Accept-Encoding']) {
			headers['Accept-Encoding'] = 'gzip, compress, deflate, br';
		}
		return headers;
	}

	/**
	 * 抖音 API 请求统一入口。
	 * 参数 headers 语义为「覆盖项 overrides」（如 { Referer } / { 'User-Agent': ... }），
	 * 必须经 buildRequestHeaders 合并：补上 Cookie/UA/Origin/Accept 等基础头。
	 * 注意不能写 `overrides || buildRequestHeaders()`——overrides 是 truthy 对象时
	 * 会整体替换基础头，导致 Cookie 丢失、抖音返回空 body。
	 * 优先走独立子进程（ELECTRON_RUN_AS_NODE）；子进程不可用时回退进程内请求。
	 */
	async fetchText(url, overrides) {
		const finalHeaders = this.buildRequestHeaders(overrides);
		try {
			const text = await this.fetchTextViaWorker(url, finalHeaders);
			this.lastTransport = 'worker';
			return text;
		} catch (workerError) {
			this.lastTransport = 'fallback';
			this.workerError = workerError.message;
			console.log(`[bili-hover-viewer] 抖音请求 worker 失败，回退进程内请求: ${workerError.message}`);
			return this.fetchTextInProcess(url, finalHeaders);
		}
	}

	/** 常驻子进程请求：纯 Node 网络环境隔离；复用同一进程避免冷启动开销 */
	fetchTextViaWorker(url, headers) {
		const sentCookieLen = headers && headers.Cookie ? String(headers.Cookie).length : 0;
		const sentUrlLen = String(url).length;
		return dyWorker.request({ url, headers, timeout: REQUEST_TIMEOUT_MS }).then((result) => {
			const text = result.text || '';
			this.lastDiag = result.diag || null;
			this.lastResInfo = result.resInfo || null;
			this.lastReqEcho = result.reqEcho || null;
			// 核对 stdin 是否截断：worker 实际收到的 Cookie/URL 长度必须与发出一致
			const echoCookie = result.reqEcho && result.reqEcho.cookie ? result.reqEcho.cookie : { len: -1 };
			const echoUrlLen = result.reqEcho ? result.reqEcho.urlLen : -1;
			const cookieMatch = echoCookie.len === sentCookieLen;
			const urlMatch = echoUrlLen === sentUrlLen;
			const info = result.resInfo || {};
			const socket = info.socket || {};
			console.log(
				`[bili-hover-viewer] 抖音请求(worker) ${new URL(url).pathname} → ${result.status}, body ${text.length} 字节; `
				+ `cookie 发出${sentCookieLen}/收到${echoCookie.len} ${cookieMatch ? '一致' : '★不一致★'}; `
				+ `url 发出${sentUrlLen}/收到${echoUrlLen} ${urlMatch ? '一致' : '★不一致★'}; `
				+ `TCP对端 ${socket.remoteAddress}:${socket.remotePort}; `
				+ `content-length=${info.headers && info.headers['content-length']} server=${info.headers && info.headers.server} via=${info.headers && info.headers.via}; `
				+ `代理env="${result.diag ? result.diag.proxyEnv : ''}"`
			);
			if (!cookieMatch) {
				throw new Error(`worker 收到的 Cookie 长度(${echoCookie.len})与发出(${sentCookieLen})不一致，stdin 传输异常`);
			}
			if (!urlMatch) {
				throw new Error(`worker 收到的 URL 长度(${echoUrlLen})与发出(${sentUrlLen})不一致，stdin 传输异常`);
			}
			return text;
		});
	}

	/** worker 可用性自检（ping）：扩展激活后预热常驻进程（顺带完成冷启动，首次刷流即无冷启动延迟） */
	async pingWorker() {
		try {
			await dyWorker.request({ ping: true }, DY_WORKER_STARTUP_MS);
			this.workerPing = { ok: true };
		} catch (error) {
			this.workerPing = { ok: false, error: error.message };
			console.log('[bili-hover-viewer] worker 自检失败（抖音请求将回退进程内）:', error.message);
		}
	}

	/**
	 * 进程内请求（fallback）。用 node http/https 模块 + 显式自有 Agent，
	 * 尽量绕过扩展宿主 vscode-proxy-agent 对全局 Agent 的 patch
	 */
	fetchTextInProcess(url, headers) {
		return new Promise((resolve, reject) => {
			const doRequest = (target, redirectsLeft) => {
				const mod = target.startsWith('https:') ? https : http;
				if (!this._agents) {
					this._agents = { [http]: new http.Agent({ keepAlive: true }), [https]: new https.Agent({ keepAlive: true }) };
				}
				const req = mod.get(target, { headers, agent: this._agents[mod] }, (res) => {
					const status = res.statusCode || 0;
					const location = res.headers.location;
					if (location && redirectsLeft > 0 && [301, 302, 303, 307, 308].includes(status)) {
						res.resume();
						doRequest(new URL(location, target).toString(), redirectsLeft - 1);
						return;
					}
					if (status !== 200) {
						res.resume();
						reject(Object.assign(new Error(`HTTP ${status}`), { apiCode: -1 }));
						return;
					}
					// 与 axios 行为对齐：请求带 Accept-Encoding 时按 content-encoding 解压
					let stream = res;
					const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
					try {
						if (encoding.includes('br')) {
							stream = res.pipe(zlib.createBrotliDecompress());
						} else if (encoding.includes('gzip')) {
							stream = res.pipe(zlib.createGunzip());
						} else if (encoding.includes('deflate')) {
							stream = res.pipe(zlib.createInflate());
						}
					} catch (error) {
						reject(Object.assign(new Error(`响应解压失败（${encoding}）: ${error.message}`), { apiCode: -1 }));
						return;
					}
					const chunks = [];
					stream.on('data', (chunk) => chunks.push(chunk));
					stream.on('error', (error) => reject(Object.assign(error, { apiCode: -1 })));
					stream.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						console.log(`[bili-hover-viewer] 抖音请求(进程内fallback) ${new URL(target).pathname} → ${status}, body ${text.length} 字节, encoding: ${encoding || 'none'}`);
						resolve(text);
					});
				});
				req.on('error', reject);
				req.setTimeout(REQUEST_TIMEOUT_MS, () => {
					req.destroy(Object.assign(new Error('请求超时'), { apiCode: -1 }));
				});
			};
			doRequest(url, 3);
		});
	}

	/** JSON GET（抖音接口登录态缺失时返回 200 空 body） */
	async fetchJson(url, headers) {
		const text = await this.fetchText(url, headers);
		if (!text) {
			// 错误信息直接展示实际传输路径与深度诊断，便于在 UI 上定位（不用翻开发者日志）
			let hint = '抖音返回空数据，登录态可能已失效';
			if (this.lastTransport === 'worker') {
				const info = this.lastResInfo || {};
				const socket = info.socket || {};
				const h = info.headers || {};
				const echo = this.lastReqEcho || {};
				hint += `（worker: 对端${socket.remoteAddress}:${socket.remotePort}, content-length=${h['content-length']}, server=${h.server}, via=${h.via}, 收到cookie长度=${echo.cookie ? echo.cookie.len : '?'}）`;
			} else {
				hint += `（进程内fallback；worker 不可用: ${this.workerError || '未知原因'}）`;
			}
			throw Object.assign(new Error(hint), { needCookie: true });
		}
		return JSON.parse(text);
	}

	/** 推荐流 URL（对齐可用组合：platform=PC + timestamp；整 URL 走 a_bogus 签名） */
	buildFeedUrl(refreshIndex) {
		const params = new URLSearchParams({
			device_platform: 'webapp',
			aid: '6383',
			channel: 'channel_pc_web',
			filterGids: '',
			tag_id: '',
			share_aweme_id: '',
			live_insert_type: '',
			count: String(DY_FEED_COUNT),
			refresh_index: String(refreshIndex),
			video_type_select: '1',
			aweme_pc_rec_raw_data: JSON.stringify({
				is_client: false, ff_danmaku_status: 1, danmaku_switch_status: 1, is_dash_user: 1,
				is_auto_play: 0, is_full_screen: 0, is_full_webscreen: 0, is_mute: 0, is_speed: 1,
				is_visible: 1, related_recommend: 1, is_xigua_user: 0,
			}),
			globalwid: '',
			pull_type: '2',
			min_window: '0',
			free_right: '0',
			view_count: '0',
			plug_block: '0',
			ug_source: '',
			creative_id: '',
			pc_client_type: '1',
			pc_libra_divert: 'Windows',
			support_h265: '1',
			support_dash: '1',
			webcast_sdk_version: '170400',
			webcast_version_code: '170400',
			version_code: '170400',
			version_name: '17.4.0',
			cookie_enabled: 'true',
			screen_width: '1920',
			screen_height: '1080',
			browser_language: 'zh-CN',
			browser_platform: 'Win32',
			browser_name: 'Chrome',
			browser_version: '150.0.0.0',
			browser_online: 'true',
			engine_name: 'Blink',
			engine_version: '150.0.0.0',
			os_name: 'Windows',
			os_version: '10',
			platform: 'PC',
			timestamp: String(Math.floor(Date.now() / 1000)),
		});
		return `${ENDPOINT_DY_TAB_FEED}?${params.toString()}`;
	}

	/** 关注流 URL（对齐可用精简参数集，129 UA 签名） */
	buildFollowingUrl(maxCursor) {
		const params = new URLSearchParams({
			device_platform: 'webapp',
			aid: '6383',
			channel: 'channel_pc_web',
			count: String(DY_FOLLOW_COUNT),
			min_cursor: '0',
			max_cursor: String(maxCursor || 0),
			cookie_enabled: 'true',
			browser_language: 'zh-CN',
			browser_platform: 'Win32',
		});
		return `${ENDPOINT_DY_FOLLOW_FEED}?${params.toString()}`;
	}

	/** 推荐流（150 UA 签名 + 登录态 Cookie） */
	async getFeed(refreshIndex = 1) {
		if (!this.userCookie) {
			throw Object.assign(new Error('请先设置抖音Cookie'), { needCookie: true });
		}
		const body = await this.fetchJson(signDouyinUrl(this.buildFeedUrl(refreshIndex), DY_UA), {
			Referer: 'https://www.douyin.com/?recommend=1',
		});
		if (body && typeof body.status_code === 'number' && body.status_code !== 0 && !body.aweme_list) {
			throw new Error(body.status_msg || `抖音接口异常（code ${body.status_code}）`);
		}
		return douyinListFromBody(body);
	}

	/** 关注流（129 UA 签名 + 登录态 Cookie，Referer 为关注页） */
	async getFollowing(maxCursor = 0) {
		if (!this.userCookie) {
			throw Object.assign(new Error('请先设置抖音Cookie'), { needCookie: true });
		}
		const body = await this.fetchJson(signDouyinUrl(this.buildFollowingUrl(maxCursor), DY_UA_FOLLOW), {
			'User-Agent': DY_UA_FOLLOW,
			Referer: 'https://www.douyin.com/follow',
		});
		if (body && typeof body.status_code === 'number' && body.status_code !== 0 && !body.data) {
			throw new Error(body.status_msg || `抖音接口异常（code ${body.status_code}）`);
		}
		return douyinListFromBody(body);
	}

	/**
	 * 搜索 URL（general/search/single，150 UA 签名）。
	 * 注意：搜索接口风控等级远高于推荐/关注流，账号被标记时服务端返回
	 * search_nil_info.search_nil_type === 'verify_check'（强制人机验证），签名正确也无法绕过。
	 */
	buildSearchUrl(keyword, offset) {
		const params = new URLSearchParams({
			device_platform: 'webapp',
			aid: '6383',
			channel: 'channel_pc_web',
			search_channel: 'aweme_general',
			sort_type: '0',
			publish_time: '0',
			keyword: String(keyword || ''),
			// search_id 为浏览器侧生成的随机标识（32 位 hex 可通过服务端格式校验）
			search_id: crypto.randomBytes(16).toString('hex'),
			query_correct_type: '1',
			is_filter_search: '0',
			from_group_id: '',
			offset: String(offset || 0),
			count: '10',
			need_filter_settings: '1',
			list_type: 'multi',
			pc_client_type: '1',
			version_code: '170400',
			version_name: '17.4.0',
			cookie_enabled: 'true',
			browser_language: 'zh-CN',
			browser_platform: 'Win32',
			browser_name: 'Chrome',
			browser_version: '150.0.0.0',
			os_name: 'Windows',
			os_version: '10',
			platform: 'PC',
		});
		// Cookie 中若带 msToken 则附上（浏览器复制的 Cookie 通常不含；缺省不影响接口可达性）
		const msTokenMatch = this.userCookie.match(/(?:^|;\s*)msToken=([^;]+)/);
		if (msTokenMatch && msTokenMatch[1]) {
			params.set('msToken', decodeURIComponent(msTokenMatch[1]));
		}
		return `${ENDPOINT_DY_SEARCH}?${params.toString()}`;
	}

	/**
	 * 关键词搜索（offset 分页，步长 10）。
	 * @returns {{ entries, hasMore, offset }}
	 * verify_check 风控时抛出带 verifyRequired 标记的错误，由前端引导用户去浏览器完成验证。
	 */
	async search(keyword, offset = 0) {
		const trimmed = String(keyword || '').trim();
		if (!trimmed) {
			return { entries: [], hasMore: false, offset: 0 };
		}
		if (!this.userCookie) {
			throw Object.assign(new Error('请先设置抖音Cookie'), { needCookie: true });
		}
		const referer = `https://www.douyin.com/search/${encodeURIComponent(trimmed)}?type=general`;
		const url = signDouyinUrl(this.buildSearchUrl(trimmed, offset), DY_UA);
		const body = await this.fetchJson(url, { Referer: referer });
		// 风控：强制人机验证（实测搜索接口在账号被标记时稳定返回该标记，非签名问题）
		const nilType = body && body.search_nil_info ? body.search_nil_info.search_nil_type : '';
		const rows = Array.isArray(body.data) ? body.data : [];
		if ((nilType === 'verify_check' || rows.length === 0) && Number(offset) === 0) {
			throw Object.assign(new Error('抖音搜索需要人机验证：请在浏览器打开抖音完成一次搜索验证后重试'), {
				verifyRequired: nilType === 'verify_check',
				keyword: trimmed,
			});
		}
		const entries = rows
			.map((row) => (row && (row.aweme_info || row.aweme)) || null)
			.filter(Boolean)
			.map(douyinEntryFromAweme)
			.filter(Boolean);
		// 搜索接口 has_more 为 0/1；无明确游标时用 offset 累加
		const hasMore = Boolean(body.has_more);
		return { entries, hasMore, offset: Number(offset) + 10 };
	}
}

// ---------- 抖音：本地媒体代理 ----------
/**
 * webview 直连抖音 CDN 会 403（缺 Referer/Cookie/UA），故所有媒体经本地代理转发。
 * 注意 fetch 跨域重定向会丢弃自定义头，必须用 http/https 模块手动跟随重定向并全程附带请求头。
 */
class DouyinMediaProxy {
	constructor() {
		this.server = null;
		this.port = 0;
		this.startPromise = null; // 启动 Promise（伪装面板等晚于激活的调用方可 await 同一 Promise）
	}

	get cookie() {
		return DouyinClient.cleanCookie(readConfig('douyinCookie', ''));
	}

	start() {
		if (this.startPromise) {
			return this.startPromise;
		}
		this.startPromise = new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => this.handle(req, res));
			this.server.on('error', (error) => {
				console.error('[bili-hover-viewer] 抖音媒体代理启动失败:', error);
				this.server = null;
				this.startPromise = null;
				reject(error);
			});
			// 127.0.0.1 随机端口，仅本机可访问
			this.server.listen(0, '127.0.0.1', () => {
				this.port = this.server.address().port;
				resolve(this.port);
			});
		});
		return this.startPromise;
	}

	/** 供伪装面板等等待代理就绪（未启动时返回已决 Promise） */
	ready() {
		return this.startPromise || Promise.resolve(this.port);
	}

	stop() {
		if (this.server) {
			this.server.close();
			this.server = null;
			this.port = 0;
		}
		this.startPromise = null;
		// 释放 keepAlive 连接池
		if (this._agents) {
			for (const agent of Object.values(this._agents)) {
				agent.destroy();
			}
			this._agents = null;
		}
	}

	/** 把抖音 CDN 地址转换为本地代理地址 */
	localUrl(url) {
		return `http://127.0.0.1:${this.port}/dy-media?url=${encodeURIComponent(url)}`;
	}

	handle(req, res) {
		let target = '';
		try {
			target = new URL(req.url, 'http://127.0.0.1').searchParams.get('url') || '';
		} catch (error) {
			target = '';
		}
		if (!target || !/^https?:\/\//i.test(target)) {
			res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('bad request');
			return;
		}
		this.forward(target, req, res, DY_PROXY_MAX_REDIRECTS);
	}

	/** 转发请求到抖音 CDN：附带 Cookie/UA/Referer，透传 Range，手动跟随重定向 */
	forward(target, req, res, redirectsLeft) {
		const headers = {
			'User-Agent': DY_UA,
			Referer: DY_REFERER,
			Origin: DY_REFERER,
			Accept: '*/*',
		};
		if (this.cookie) {
			headers.Cookie = this.cookie;
		}
		if (req.headers.range) {
			headers.Range = req.headers.range; // 透传 Range 以支持进度条拖动
		}
		const mod = target.startsWith('https:') ? https : http;
		// 显式自有 Agent 绕过扩展宿主代理 patch（同 DouyinClient.fetchText，强制直连）
		if (!this._agents) {
			this._agents = { [http]: new http.Agent({ keepAlive: true }), [https]: new https.Agent({ keepAlive: true }) };
		}
		const upstream = mod.get(target, { headers, agent: this._agents[mod] }, (upstreamRes) => {
			const status = upstreamRes.statusCode || 0;
			const location = upstreamRes.headers.location;
			if (location && redirectsLeft > 0 && [301, 302, 303, 307, 308].includes(status)) {
				upstreamRes.resume(); // 丢弃重定向响应体
				const next = new URL(location, target).toString();
				this.forward(next, req, res, redirectsLeft - 1);
				return;
			}
			// 仅透传上游实际返回的长度/范围头：全量请求（如下载，不带 Range）时上游无 content-range，
			// 无条件写入 undefined 会触发 ERR_HTTP_INVALID_HEADER_VALUE 导致代理崩溃
			const respHeaders = {
				'Content-Type': upstreamRes.headers['content-type'] || 'application/octet-stream',
				'Accept-Ranges': upstreamRes.headers['accept-ranges'] || 'bytes',
			};
			if (upstreamRes.headers['content-length'] !== undefined) {
				respHeaders['Content-Length'] = upstreamRes.headers['content-length'];
			}
			if (upstreamRes.headers['content-range'] !== undefined) {
				respHeaders['Content-Range'] = upstreamRes.headers['content-range'];
			}
			res.writeHead(status, respHeaders);
			upstreamRes.pipe(res);
		});
		upstream.on('error', (error) => {
			console.error('[bili-hover-viewer] 媒体代理转发失败:', target, error.message);
			if (!res.headersSent) {
				res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
			}
			res.end('proxy error');
		});
	}
}

module.exports = {
	DY_MAX_LIST_SIZE,
	DouyinEntry,
	DouyinClient,
	DouyinMediaProxy,
	dyWorker,
};
