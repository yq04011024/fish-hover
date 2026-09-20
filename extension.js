const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { signDouyinUrl } = require('./dy-signer');

/* ============================================================
 * bili-hover-viewer
 * 侧边栏推荐视频（Cookie 个性化 / 随机）+ 悬停显隐小窗播放器
 * ============================================================ */

// ---------- 常量 ----------
const FEED_DISPLAY_LIMIT = 8; // 侧边栏推荐列表最多展示条数
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_SIDEBAR_TITLE = '聚焦视界'; // 与 package.json 默认值保持一致
const DEFAULT_PANE_TITLE = 'jsProject00111.js'; // 伪装模式下播放面板标题（伪装成本地代码文件）
const DEFAULT_OPEN_PANE_TITLE = 'B站视频'; // 不伪装模式的播放面板标题
const DISGUISE_MAX_LINES = 600; // 伪装文件最多渲染行数

// B站公开接口（GET）
const ENDPOINT_STORY_FEED = 'https://app.bilibili.com/x/v2/feed/index/story';
const ENDPOINT_RECOMMEND_RCMD =
	'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd' +
	'?web_location=1430650&y_num=5&fresh_type=3&feed_version=V8&homepage_ver=1&ps=10&last_y_num=5&screen=2010-595';
const ENDPOINT_SEARCH = 'https://api.bilibili.com/x/web-interface/search/type';
const ENDPOINT_VIDEO_INFO = 'https://api.bilibili.com/x/web-interface/view';
const ENDPOINT_PLAY_URL = 'https://api.bilibili.com/x/player/wbi/playurl';
const ENDPOINT_NAV = 'https://api.bilibili.com/x/web-interface/nav';
// 分区接口（热门 / 直播 / 待看）
const ENDPOINT_POPULAR = 'https://api.bilibili.com/x/web-interface/popular';
const ENDPOINT_LIVE_INDEX = 'https://api.live.bilibili.com/xlive/web-interface/v1/index/getList';
const ENDPOINT_LIVE_PLAY_INFO = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo';
const ENDPOINT_WATCHLATER = 'https://api.bilibili.com/x/v2/history/toview/web';
const ENDPOINT_ADD_VIEW_LATER = 'https://api.bilibili.com/x/v2/history/toview/add';
// 扫码登录（generate 取 url+qrcode_key，poll 轮询状态，成功后从响应 Set-Cookie 提取登录态）
const ENDPOINT_QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const ENDPOINT_QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const QR_IMAGE_SERVICE = 'https://api.qrserver.com/v1/create-qr-code/?data=';
const LOGIN_POLL_INTERVAL_MS = 2000;
// 二维码轮询状态码（passport poll 接口 data.code）
const QR_STATE_SUCCESS = 0;
const QR_STATE_EXPIRED = 86038;
const QR_STATE_CONFIRMED = 86090; // 已扫码，待手机确认
const QR_STATE_NOT_SCANNED = 86101;
const WATCHLATER_PAGE_SIZE = 12; // 待看分区前端切片页大小（接口一次返回全量）

// Cookie 失效类错误码
const COOKIE_EXPIRED_CODES = new Set([-101, -412]);

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

// ---------- 工具函数 ----------
function readConfig(key, fallback) {
	return vscode.workspace.getConfiguration('biliHover').get(key, fallback);
}

async function updateGlobalConfig(key, value) {
	await vscode.workspace
		.getConfiguration('biliHover')
		.update(key, value, vscode.ConfigurationTarget.Global);
}

/** "1:02:03" / "10:30" / 数字 → 秒 */
function parseDurationToSeconds(raw) {
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		return Math.round(raw);
	}
	if (typeof raw !== 'string' || raw.trim() === '') {
		return 0;
	}
	const parts = raw.split(':').map((p) => parseInt(p, 10) || 0);
	return parts.reduce((total, part) => total * 60 + part, 0);
}

/** 秒 → "mm:ss" / "h:mm:ss" */
function formatDuration(totalSeconds) {
	const seconds = Math.max(0, Math.round(totalSeconds));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const pad = (n) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 播放量/弹幕数缩写：12345 → 1.2万 */
function formatCount(value) {
	const num = Number(value) || 0;
	if (num >= 100000000) {
		return `${(num / 100000000).toFixed(1)}亿`;
	}
	if (num >= 10000) {
		return `${(num / 10000).toFixed(1)}万`;
	}
	return String(num);
}

/** http 资源升级为 https，避免 webview 混合内容拦截 */
function ensureHttps(url) {
	return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : '';
}

/** 清除搜索结果标题中的关键词高亮标签 */
function stripHighlightTags(text) {
	return String(text || '').replace(/<\/?em[^>]*>/gi, '');
}

function isCookieExpiredCode(code) {
	return COOKIE_EXPIRED_CODES.has(code);
}

/**
 * 从登录成功响应中提取 Set-Cookie 并拼接为 "name=value; ..." 形式的 Cookie 串
 * （优先用 undici 的 getSetCookie()，逐条取第一段 name=value）
 */
function extractCookiePairs(response) {
	try {
		let rawCookies = [];
		if (response && typeof response.headers.getSetCookie === 'function') {
			rawCookies = response.headers.getSetCookie();
		} else if (response && response.headers && response.headers.get('set-cookie')) {
			rawCookies = [response.headers.get('set-cookie')];
		}
		const pairs = rawCookies
			.map((cookie) => String(cookie).split(';')[0].trim())
			.filter((pair) => pair && pair.includes('='));
		return Array.from(new Set(pairs)).join('; ');
	} catch (error) {
		console.error('[bili-hover-viewer] 提取登录 Cookie 失败:', error);
		return '';
	}
}

/** 文件名清洗：替换 Windows 非法字符 \\ / : * ? " < > | 及控制字符，压缩空白并限长 80 */
function sanitizeFileName(name) {
	return String(name || '')
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
		.replace(/\s+/g, ' ')
		.replace(/[. ]+$/g, '')
		.trim()
		.slice(0, 80);
}

/** HTML 文本转义（用于伪装文件内容注入 webview） */
function escapeHtmlText(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** 读取 webview 页面模板文件（webview 目录下的 HTML，按伪装开关选择对应页面） */
function loadWebviewTemplate(context, fileName) {
	const filePath = path.join(context.extensionUri.fsPath, 'webview', fileName);
	return fs.readFileSync(filePath, 'utf8');
}

/** 模板占位符替换：split/join 逐对替换，避免替换值中的 $ 序列被特殊解释 */
function applyTemplate(template, replacements) {
	let html = template;
	for (const key of Object.keys(replacements)) {
		html = html.split(key).join(String(replacements[key]));
	}
	return html;
}

/**
 * 读取伪装显示文件并渲染为编辑器风格 HTML（带行号）。
 * 文件不存在/读取失败/内容为空时返回空字符串（遮罩保持纯黑）。
 */
function buildDisguiseHtml(filePath) {
	const trimmed = (filePath || '').trim();
	if (!trimmed) {
		return '';
	}
	try {
		if (!fs.existsSync(trimmed) || !fs.statSync(trimmed).isFile()) {
			return '';
		}
		const content = fs.readFileSync(trimmed, 'utf8');
		const lines = content.split(/\r?\n/).slice(0, DISGUISE_MAX_LINES);
		if (lines.length === 0) {
			return '';
		}
		const rows = lines
			.map((line, index) => {
				const lineNo = String(index + 1);
				return (
					'<div class="cl"><span class="ln">' + escapeHtmlText(lineNo) + '</span>' +
					'<span class="ct">' + (escapeHtmlText(line) || ' ') + '</span></div>'
				);
			})
			.join('');
		return '<div class="disguise">' + rows + '</div>';
	} catch (error) {
		console.error('[bili-hover-viewer] 读取伪装文件失败:', error);
		return '';
	}
}

/**
 * 将配置的侧边栏标题同步写入扩展自身的 package.json（需重启编辑器生效）。
 */
function syncSidebarTitleFromConfig(context) {
	try {
		const configuredTitle = (readConfig('sidebarViewTitle', DEFAULT_SIDEBAR_TITLE) || '').trim() || DEFAULT_SIDEBAR_TITLE;
		const pkgPath = path.join(context.extensionUri.fsPath, 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		const container = pkg.contributes && pkg.contributes.viewsContainers && pkg.contributes.viewsContainers.activitybar && pkg.contributes.viewsContainers.activitybar[0];
		const views = (pkg.contributes && pkg.contributes.views && pkg.contributes.views.biliHoverView) || [];
		let changed = false;
		if (container && container.title !== configuredTitle) {
			container.title = configuredTitle;
			changed = true;
		}
		for (const view of views) {
			if (view.name !== configuredTitle) {
				view.name = configuredTitle;
				changed = true;
			}
		}
		if (changed) {
			fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n', 'utf8');
			vscode.window.showInformationMessage('侧边栏标题已更新，重启编辑器后生效');
		}
	} catch (error) {
		console.error('[bili-hover-viewer] 同步侧边栏标题失败:', error);
		vscode.window.showWarningMessage('侧边栏标题写入失败：' + (error instanceof Error ? error.message : '未知错误'));
	}
}

// ---------- 数据模型 ----------
/**
 * 统一的视频条目：来自推荐流 / 搜索 / 兜底示例的归一化结果
 */
class VideoEntry {
	constructor({ bvid, avid, cid, title, uploader, uploaderFace, cover, durationSec, summary, playCount, danmakuCount, pubdate }) {
		this.pubdate = pubdate || 0; // 发布时间（unix 秒）
		this.bvid = bvid || '';
		this.avid = avid || 0;
		this.cid = cid || 0;
		this.title = title || '（无标题）';
		this.uploader = uploader || '未知UP主';
		this.uploaderFace = ensureHttps(uploaderFace);
		this.cover = ensureHttps(cover);
		this.durationSec = durationSec || 0;
		this.summary = summary || '';
		this.playCount = playCount || 0;
		this.danmakuCount = danmakuCount || 0;
	}

	get pageUrl() {
		return this.bvid ? `https://www.bilibili.com/video/${this.bvid}` : '';
	}

	get durationText() {
		return formatDuration(this.durationSec);
	}

	get dateText() {
		if (!this.pubdate) {
			return '';
		}
		const date = new Date(this.pubdate * 1000);
		if (Number.isNaN(date.getTime())) {
			return '';
		}
		const pad = (n) => String(n).padStart(2, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	}
}

/** VideoEntry → 可序列化普通对象（传给 webview 用） */
function serializeEntry(entry) {
	return {
		bvid: entry.bvid,
		title: entry.title,
		uploader: entry.uploader,
		uploaderFace: entry.uploaderFace,
		dateText: entry.dateText,
		cover: entry.cover && entry.cover.startsWith('//') ? `https:${entry.cover}` : entry.cover,
		durationText: entry.durationText,
		playCountText: formatCount(entry.playCount),
		danmakuCountText: formatCount(entry.danmakuCount),
		summary: entry.summary,
		pageUrl: entry.pageUrl,
	};
}

/** 推荐流可播过滤：仅保留 AV 视频（排除图文/直播等卡片，避免"未知UP主"且不可播的条目） */
function isPlayableFeedItem(item) {
	return Boolean(item) && (item.goto ? item.goto === 'av' : true) && Boolean(item.bvid);
}

/** 直播房间 → 可序列化条目（isLive 标记，roomId 供原位播放拉流） */
function serializeLiveRoom(room) {
	const roomUrl = `https://live.bilibili.com/${room.roomId}`;
	return {
		bvid: '',
		roomId: room.roomId,
		title: room.title,
		uploader: room.uname,
		uploaderFace: ensureHttps(room.face),
		dateText: '',
		cover: ensureHttps(room.cover),
		durationText: '',
		playCountText: formatCount(room.online),
		danmakuCountText: '',
		summary: '',
		pageUrl: roomUrl,
		isLive: true,
		roomUrl,
	};
}

/** 搜索结果可播过滤：仅保留带 BV 号和 UP 主的视频类型（排除失效/特殊卡片） */
function isPlayableSearchItem(item) {
	return Boolean(item) && item.type === 'video' && Boolean(item.bvid) && Boolean(item.author);
}

/** 归一化推荐流（story / rcmd 两种返回结构） */
function videoEntryFromFeedItem(item) {
	return new VideoEntry({
		bvid: item.bvid,
		avid: (item.player_args && item.player_args.aid) || item.aid,
		cid: (item.player_args && item.player_args.cid) || item.cid,
		title: item.title,
		uploader: item.owner && item.owner.name,
		uploaderFace: item.owner && item.owner.face,
		cover: item.cover || item.pic,
		durationSec: item.duration,
		pubdate: item.pubdate,
		summary: item.desc,
		playCount: item.stat && item.stat.view,
		danmakuCount: item.stat && item.stat.danmaku,
	});
}

/** 归一化搜索结果 */
function videoEntryFromSearchItem(item) {
	return new VideoEntry({
		bvid: item.bvid,
		avid: item.aid,
		cid: 0, // 搜索结果不含 cid，播放时按 bvid 查询
		title: stripHighlightTags(item.title),
		uploader: item.author,
		uploaderFace: item.upic,
		cover: item.pic,
		durationSec: parseDurationToSeconds(item.duration),
		pubdate: item.pubdate,
		summary: item.description,
		playCount: parseInt(item.play, 10) || 0,
		danmakuCount: parseInt(item.video_review, 10) || 0,
	});
}

// ---------- API 客户端 ----------
class VideoFeedClient {
	constructor() {}

	get userCookie() {
		return (readConfig('userCookie', '') || '').trim();
	}

	/** 组装请求头：Cookie（可选）+ 浏览器 UA + B站 Referer/Origin */
	buildRequestHeaders() {
		const headers = {
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			Referer: 'https://www.bilibili.com/',
			Origin: 'https://www.bilibili.com',
		};
		if (this.userCookie) {
			headers.Cookie = this.userCookie;
		}
		return headers;
	}

	/** 带超时的 GET，返回 { body, response }（登录 Cookie 提取需要响应头） */
	async fetchJsonRaw(url) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(url, {
				headers: this.buildRequestHeaders(),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw Object.assign(new Error(`HTTP ${response.status}`), { apiCode: -1 });
			}
			const body = await response.json();
			return { body, response };
		} finally {
			clearTimeout(timer);
		}
	}

	/** 带超时的 JSON GET */
	async fetchJson(url) {
		const { body } = await this.fetchJsonRaw(url);
		return body;
	}

	/**
	 * 推荐视频列表：
	 * 有 Cookie → 个性化推荐（wbi rcmd），失败降级 story feed；
	 * 无 Cookie → story feed 随机推荐。
	 * 返回 { entries, degradedByCookie }：degradedByCookie 表示 Cookie 失效被降级，供上层提示。
	 */
	async fetchRecommendVideos() {
		const errors = [];
		let degradedByCookie = false;
		if (this.userCookie) {
			try {
				const body = await this.fetchJson(ENDPOINT_RECOMMEND_RCMD);
				if (body.code === 0 && Array.isArray(body.data && body.data.item) && body.data.item.length > 0) {
					return { entries: body.data.item.filter(isPlayableFeedItem).map(videoEntryFromFeedItem).slice(0, FEED_DISPLAY_LIMIT), degradedByCookie };
				}
				if (isCookieExpiredCode(body.code)) {
					degradedByCookie = true;
				}
				errors.push(Object.assign(new Error(body.message || '推荐接口返回为空'), { apiCode: body.code }));
			} catch (error) {
				if (isCookieExpiredCode(error && error.apiCode)) {
					degradedByCookie = true;
				}
				errors.push(error);
			}
		}
		try {
			const body = await this.fetchJson(ENDPOINT_STORY_FEED);
			if (body.code === 0 && Array.isArray(body.data && body.data.items) && body.data.items.length > 0) {
				return { entries: body.data.items.filter(isPlayableFeedItem).map(videoEntryFromFeedItem).slice(0, FEED_DISPLAY_LIMIT), degradedByCookie };
			}
			errors.push(Object.assign(new Error(body.message || '推荐接口返回为空'), { apiCode: body.code }));
		} catch (error) {
			errors.push(error);
		}
		throw errors[errors.length - 1] || new Error('获取推荐视频失败');
	}

	/** 关键词搜索（返回当页条目与总命中数） */
	async searchVideosByKeyword(keyword, page = 1) {
		const url =
			`${ENDPOINT_SEARCH}?search_type=video&keyword=${encodeURIComponent(keyword)}` +
			`&page=${encodeURIComponent(page)}`;
		const body = await this.fetchJson(url);
		if (body.code !== 0) {
			throw Object.assign(new Error(body.message || '搜索失败'), { apiCode: body.code });
		}
		const results = ((body.data && body.data.result) || []).filter(isPlayableSearchItem);
		const numResults = (body.data && body.data.numResults) || 0;
		return { entries: results.map(videoEntryFromSearchItem), numResults };
	}

	/** 登录用户信息（头像/昵称）：未登录或请求失败返回 null */
	async fetchUserInfo() {
		try {
			const body = await this.fetchJson(ENDPOINT_NAV);
			if (body.code === 0 && body.data && body.data.isLogin) {
				return { face: ensureHttps(body.data.face), uname: body.data.uname || '' };
			}
		} catch (error) {
			// 未配置 Cookie 或请求失败时按未登录处理
		}
		return null;
	}

	// ----- 分区数据（热门 / 直播 / 动态 / 待看） -----

	/** 热门视频（每页 20 条，pn 翻页） */
	async fetchPopularVideos(page = 1) {
		const url = `${ENDPOINT_POPULAR}?ps=20&pn=${encodeURIComponent(page)}`;
		const body = await this.fetchJson(url);
		if (body.code !== 0 || !body.data || !Array.isArray(body.data.list)) {
			throw Object.assign(new Error(body.message || '获取热门视频失败'), { apiCode: body.code });
		}
		return body.data.list
			.filter((item) => item && item.bvid)
			.map((item) => new VideoEntry({
				bvid: item.bvid,
				avid: item.aid,
				cid: item.cid || 0,
				title: item.title,
				uploader: item.owner && item.owner.name,
				uploaderFace: item.owner && item.owner.face,
				// 热门接口的 pic 可能为协议相对形式（//i0.hdslb.com/...）
				cover: item.pic && item.pic.startsWith('//') ? `https:${item.pic}` : item.pic,
				durationSec: item.duration,
				pubdate: item.pubdate,
				summary: (item.rcmd_reason && item.rcmd_reason.content) || '',
				playCount: item.stat && item.stat.view,
				danmakuCount: item.stat && item.stat.danmaku,
			}));
	}

	/**
	 * 直播推荐房间（返回归一化房间数组，点击在浏览器打开直播间）。
	 * 旧版 webMain/getPage 已下线（HTTP 404），改用直播首页 index/getList：
	 * 该接口无翻页参数，但推荐位（recommend_room_list）每次请求都会轮换，
	 * 热门位（room_list）相对固定；excludeRoomIds 传入已展示集合时仅返回未展示过的新房间。
	 */
	async fetchLiveRooms(excludeRoomIds) {
		const body = await this.fetchJson(`${ENDPOINT_LIVE_INDEX}?platform=web`);
		if (body.code !== 0 || !body.data) {
			throw Object.assign(new Error(body.message || '获取直播列表失败'), { apiCode: body.code });
		}
		const excluded = excludeRoomIds || new Set();
		const seen = new Set();
		const rooms = [];
		const allRooms = [...(body.data.room_list || []), ...(body.data.recommend_room_list || [])];
		for (const room of allRooms) {
			const roomId = (room && (room.room_id || room.roomid)) || 0;
			if (!roomId || seen.has(roomId) || excluded.has(roomId)) {
				continue;
			}
			seen.add(roomId);
			rooms.push({
				roomId,
				title: room.title || '直播间',
				uname: room.uname || '',
				face: room.face || '',
				cover: room.user_cover || room.cover || room.system_cover || room.keyframe || '',
				online: room.online || 0,
			});
		}
		return rooms;
	}

	/**
	 * 解析直播 HLS 流地址（webview 内用 hls.js 播放）。
	 * 旧版 room/v1/Room/playUrl 已下线（HTTP 404），改用 TouchFish 同款 v2 接口：
	 * 按 http_hls(fmp4) → http_hls(首个) → http_stream 优先级取流，URL = host + base_url + extra。
	 */
	async resolveLiveStream(roomId) {
		const url = `${ENDPOINT_LIVE_PLAY_INFO}?room_id=${encodeURIComponent(roomId)}`
			+ '&protocol=0,1&format=0,1,2&codec=0&qn=10000&platform=android&ptype=16';
		const body = await this.fetchJson(url);
		if (body.code !== 0 || !body.data) {
			throw Object.assign(new Error(body.message || '获取直播流失败'), { apiCode: body.code });
		}
		const streams = (body.data.playurl_info
			&& body.data.playurl_info.playurl
			&& body.data.playurl_info.playurl.stream) || [];
		const pickStreamUrl = (protocolName, formatName) => {
			const stream = streams.find((item) => item && item.protocol_name === protocolName);
			if (!stream) {
				return '';
			}
			const format = (stream.format || []).find((item) => item && item.format_name === formatName)
				|| (stream.format || [])[0];
			if (!format) {
				return '';
			}
			const codec = (format.codec || []).find((item) => item && item.codec_name === 'avc')
				|| (format.codec || [])[0];
			const urlInfo = codec && codec.url_info && codec.url_info[0];
			if (codec && codec.base_url && urlInfo && urlInfo.host) {
				return ensureHttps(`${urlInfo.host}${codec.base_url}${urlInfo.extra || ''}`);
			}
			return '';
		};
		const streamUrls = [
			pickStreamUrl('http_hls', 'fmp4'),
			pickStreamUrl('http_hls'),
			pickStreamUrl('http_stream'),
		].filter(Boolean);
		if (streamUrls.length === 0) {
			throw new Error('未能取得可用的直播流地址');
		}
		return { streamUrls };
	}

	/**
	 * 加入稍后再看（同 TouchFish：POST toview/add，body 为 bvid + csrf(bili_jct) 表单）。
	 * 需要登录 Cookie 且其中包含 bili_jct 字段。
	 */
	async addToViewLater(bvid) {
		if (!bvid) {
			throw new Error('缺少视频 bvid');
		}
		if (!this.userCookie) {
			throw Object.assign(new Error('尚未登录，请先点击右上角「登录」扫码'), { needLogin: true });
		}
		const csrfMatch = this.userCookie.match(/bili_jct=([^;]+)/);
		const csrf = csrfMatch ? csrfMatch[1] : null;
		if (!csrf) {
			throw new Error('无法从 Cookie 中获取 CSRF Token（缺少 bili_jct），请重新扫码登录');
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(ENDPOINT_ADD_VIEW_LATER, {
				method: 'POST',
				headers: {
					...this.buildRequestHeaders(),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: `bvid=${encodeURIComponent(bvid)}&csrf=${encodeURIComponent(csrf)}`,
				signal: controller.signal,
			});
			if (!response.ok) {
				throw Object.assign(new Error(`HTTP ${response.status}`), { apiCode: -1 });
			}
			const body = await response.json();
			if (body.code !== 0) {
				throw Object.assign(new Error(body.message || '加入稍后再看失败'), { apiCode: body.code });
			}
			return body;
		} finally {
			clearTimeout(timer);
		}
	}

	/** 待看清单（需登录 Cookie；接口一次返回全量，由调用方按页切片） */
	async fetchWatchLaterVideos() {
		const body = await this.fetchJson(ENDPOINT_WATCHLATER);
		if (body.code !== 0 || !body.data || !Array.isArray(body.data.list)) {
			throw Object.assign(new Error(body.message || '获取待看列表失败'), { apiCode: body.code });
		}
		return body.data.list
			.filter((item) => item && item.bvid)
			.map((item) => new VideoEntry({
				bvid: item.bvid,
				avid: item.aid,
				cid: item.cid || 0,
				title: item.title,
				uploader: item.owner && item.owner.name,
				uploaderFace: item.owner && item.owner.face,
				cover: item.pic,
				durationSec: item.duration,
				pubdate: item.pubdate,
				summary: item.desc || '',
				playCount: item.stat && item.stat.view,
				danmakuCount: item.stat && item.stat.danmaku,
			}));
	}

	// ----- 扫码登录 -----

	/** 生成登录二维码：返回 { url, qrcodeKey, qrImageUrl } */
	async generateLoginQrcode() {
		const body = await this.fetchJson(ENDPOINT_QR_GENERATE);
		if (body.code !== 0 || !body.data || !body.data.qrcode_key) {
			throw Object.assign(new Error(body.message || '获取登录二维码失败'), { apiCode: body.code });
		}
		const qrImageUrl = `${QR_IMAGE_SERVICE}${encodeURIComponent(body.data.url)}&size=220x220`;
		return { url: body.data.url, qrcodeKey: body.data.qrcode_key, qrImageUrl };
	}

	/** 轮询二维码状态：返回 { state, cookies }（state 见 QR_STATE_*，成功时附登录 Cookie） */
	async pollLoginQrcode(qrcodeKey) {
		const { body, response } = await this.fetchJsonRaw(`${ENDPOINT_QR_POLL}?qrcode_key=${encodeURIComponent(qrcodeKey)}`);
		if (body.code !== 0 || !body.data) {
			throw Object.assign(new Error(body.message || '查询扫码状态失败'), { apiCode: body.code });
		}
		const state = body.data.code;
		if (state === QR_STATE_SUCCESS) {
			return { state, cookies: extractCookiePairs(response) };
		}
		return { state, cookies: '' };
	}

	/** 补齐 cid（搜索结果缺省）：按 bvid 查视频详情 */
	async ensureCid(entry) {
		if (entry.cid) {
			return entry.cid;
		}
		if (!entry.bvid) {
			throw new Error('该视频缺少 BV 号，无法获取播放信息');
		}
		const body = await this.fetchJson(`${ENDPOINT_VIDEO_INFO}?bvid=${encodeURIComponent(entry.bvid)}`);
		if (body.code !== 0 || !body.data || !body.data.cid) {
			throw Object.assign(new Error(body.message || '获取视频信息失败'), { apiCode: body.code });
		}
		entry.cid = body.data.cid;
		return entry.cid;
	}

	/** 解析可直连播放的 MP4 流地址 */
	async resolvePlayStream(entry) {
		await this.ensureCid(entry);
		const url =
			`${ENDPOINT_PLAY_URL}?bvid=${encodeURIComponent(entry.bvid)}` +
			`&cid=${encodeURIComponent(entry.cid)}&qn=112&platform=html5&high_quality=1`;
		const body = await this.fetchJson(url);
		if (body.code !== 0 || !body.data) {
			throw Object.assign(new Error(body.message || '获取播放地址失败'), { apiCode: body.code });
		}
		const streams = (body.data.durl || [])
			.map((seg) => seg && seg.url)
			.filter(Boolean)
			.map(ensureHttps);
		if (streams.length === 0) {
			throw new Error('未能取得可用的播放地址');
		}
		return { streamUrls: streams, qualityLabel: body.data.quality || 0 };
	}
}

// ---------- 侧边栏列表 ----------
class VideoSidebarProvider {
	constructor(feedClient, listIconUri) {
		this.feedClient = feedClient;
		this.listIconUri = listIconUri;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		this.videoEntries = [];
		this.isLoading = false;
		this.searchKeyword = '';
		// 搜索分页状态
		this.searchResults = [];        // 已取回的全部搜索结果
		this.searchTotal = 0;           // 接口报告的总命中数
		this.searchPage = 1;            // 当前展示页（从 1 开始）
		this.searchFetchedApiPages = new Set(); // 已请求过的接口页码（每页约 20 条）
		// 数据变更回调：侧边栏视频流页面据此同步数据
		this.onEntriesChanged = null;
	}

	/** 数据变更后同步通知侧边栏视频流页面 */
	notifyDataChanged() {
		if (typeof this.onEntriesChanged === 'function') {
			try {
				this.onEntriesChanged();
			} catch (error) {
				console.error('[bili-hover-viewer] 同步视频流数据失败:', error);
			}
		}
	}

	reloadFeed() {
		return this.loadRecommendVideos();
	}

	async loadRecommendVideos() {
		if (this.isLoading) {
			return;
		}
		this.isLoading = true;
		this.searchKeyword = '';
		this.searchResults = [];
		this.searchTotal = 0;
		this.searchPage = 1;
		this.searchFetchedApiPages = new Set();
		try {
			const { entries, degradedByCookie } = await this.feedClient.fetchRecommendVideos();
			this.videoEntries = entries;
			this._onDidChangeTreeData.fire();
			this.notifyDataChanged();
			const personalized = this.feedClient.userCookie ? 'Cookie 个性化' : '随机';
			vscode.window.showInformationMessage(`已加载 ${this.videoEntries.length} 条推荐视频（${personalized}）`);
			if (degradedByCookie) {
				await promptCookieSetup('B站 Cookie 已失效，当前展示随机推荐，是否重新设置 Cookie？');
			}
		} catch (error) {
			console.error('[bili-hover-viewer] 加载推荐视频失败:', error);
			vscode.window.showErrorMessage(`加载视频失败：${error instanceof Error ? error.message : '未知错误'}`);
			this.videoEntries = createFallbackEntries();
			this._onDidChangeTreeData.fire();
			this.notifyDataChanged();
			if (isCookieExpiredCode(error && error.apiCode)) {
				await promptCookieSetup('Cookie 失效或未配置，是否立即设置？');
			}
		} finally {
			this.isLoading = false;
		}
	}

	async searchByKeyword(keyword) {
		// 搜索接口未带登录 Cookie 时大概率被 B站风控拦截（-412），先引导设置
		if (!this.feedClient.userCookie) {
			const action = await vscode.window.showWarningMessage(
				'搜索功能需要登录 Cookie（未配置时B站会拒绝搜索请求），是否先设置？',
				'设置 Cookie',
				'直接搜索'
			);
			if (action === '设置 Cookie') {
				await inputAndSaveCookie();
				if (!this.feedClient.userCookie) {
					return; // 用户取消了输入
				}
			}
		}
		this.isLoading = true;
		try {
			const { entries, numResults } = await this.feedClient.searchVideosByKeyword(keyword);
			this.searchKeyword = keyword;
			this.searchResults = entries;
			this.searchTotal = numResults || entries.length;
			this.searchPage = 1;
			this.searchFetchedApiPages = new Set([1]);
			this.applySearchPage();
			const totalPages = this.totalSearchPages();
			vscode.window.showInformationMessage(
				totalPages > 1
					? `「${keyword}」搜索到约 ${this.searchTotal} 个视频，共 ${totalPages} 页`
					: `「${keyword}」搜索到 ${this.searchResults.length} 个视频`
			);
		} catch (error) {
			console.error('[bili-hover-viewer] 搜索失败:', error);
			const code = error && error.apiCode;
			const hint = code === -412
				? '请求被B站风控拦截，请确认已配置有效的登录 Cookie'
				: (error instanceof Error ? error.message : '未知错误');
			vscode.window.showErrorMessage(`搜索失败：${hint}${code ? `（code ${code}）` : ''}`);
			if (isCookieExpiredCode(code)) {
				await promptCookieSetup('搜索需要登录 Cookie（当前失效或未配置），是否立即设置？');
			}
		} finally {
			this.isLoading = false;
		}
	}

	// ----- 搜索分页 -----

	totalSearchPages() {
		return Math.max(1, Math.ceil(this.searchTotal / FEED_DISPLAY_LIMIT));
	}

	hasPrevPage() {
		return Boolean(this.searchKeyword) && this.searchPage > 1;
	}

	hasNextPage() {
		return Boolean(this.searchKeyword) && this.searchPage * FEED_DISPLAY_LIMIT < this.searchTotal;
	}

	/** 将当前页切片渲染 */
	applySearchPage() {
		const start = (this.searchPage - 1) * FEED_DISPLAY_LIMIT;
		this.videoEntries = this.searchResults.slice(start, start + FEED_DISPLAY_LIMIT);
		this._onDidChangeTreeData.fire();
		this.notifyDataChanged();
	}

	/** 确保已取回的数据覆盖到指定索引（自动请求后续接口页，每页约 20 条，按 bvid 去重） */
	async ensureSearchDataUpTo(index) {
		while (this.searchResults.length <= index && this.searchResults.length < this.searchTotal) {
			let apiPage = 1;
			while (this.searchFetchedApiPages.has(apiPage)) {
				apiPage += 1;
				if (apiPage > 100) {
					return; // 安全上限
				}
			}
			const more = await this.feedClient.searchVideosByKeyword(this.searchKeyword, apiPage);
			this.searchFetchedApiPages.add(apiPage);
			if (!more || more.entries.length === 0) {
				return; // 接口已无更多数据
			}
			const known = new Set(this.searchResults.map((v) => v.bvid));
			for (const item of more.entries) {
				if (item.bvid && !known.has(item.bvid)) {
					this.searchResults.push(item);
					known.add(item.bvid);
				}
			}
		}
	}

	async gotoNextPage() {
		if (!this.hasNextPage() || this.isLoading) {
			return;
		}
		const targetIndex = this.searchPage * FEED_DISPLAY_LIMIT; // 新页首个索引
		this.isLoading = true;
		try {
			await this.ensureSearchDataUpTo(targetIndex);
			if (this.searchResults.length <= targetIndex) {
				vscode.window.showInformationMessage('没有更多搜索结果了');
				return;
			}
			this.searchPage += 1;
			this.applySearchPage();
		} catch (error) {
			console.error('[bili-hover-viewer] 翻页失败:', error);
			vscode.window.showErrorMessage(`翻页失败：${error instanceof Error ? error.message : '未知错误'}`);
			if (isCookieExpiredCode(error && error.apiCode)) {
				await promptCookieSetup('Cookie 失效，是否立即设置？');
			}
		} finally {
			this.isLoading = false;
		}
	}

	gotoPrevPage() {
		if (!this.hasPrevPage() || this.isLoading) {
			return;
		}
		this.searchPage -= 1;
		this.applySearchPage();
	}

	getRandomEntry() {
		if (this.videoEntries.length === 0) {
			return null;
		}
		return this.videoEntries[Math.floor(Math.random() * this.videoEntries.length)];
	}

	getTreeItem(entry) {
		// 分页控制节点
		if (entry && entry.isPagination) {
			const isPrev = entry.direction === 'prev';
			const treeItem = new vscode.TreeItem(isPrev ? '◀ 上一页' : '▶ 下一页', vscode.TreeItemCollapsibleState.None);
			treeItem.iconPath = new vscode.ThemeIcon(isPrev ? 'arrow-left' : 'arrow-right');
			treeItem.description = isPrev
				? `第 ${this.searchPage} / ${this.totalSearchPages()} 页`
				: `进入第 ${this.searchPage + 1} / ${this.totalSearchPages()} 页`;
			treeItem.command = {
				command: isPrev ? 'biliHover.searchPrevPage' : 'biliHover.searchNextPage',
				title: isPrev ? '上一页' : '下一页',
			};
			return treeItem;
		}
		const treeItem = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
		treeItem.description = `@${entry.uploader} · ${entry.durationText}`;
		treeItem.tooltip = new vscode.MarkdownString(
			[
				`**${entry.title}**`,
				`UP主：@${entry.uploader}`,
				`时长：${entry.durationText}　播放：${formatCount(entry.playCount)}　弹幕：${formatCount(entry.danmakuCount)}`,
				entry.summary ? `\n\n${entry.summary}` : '',
			].join('\n')
		);
		treeItem.iconPath = this.listIconUri;
		treeItem.command = {
			command: 'biliHover.playSelectedVideo',
			title: '播放该视频',
			arguments: [entry],
		};
		return treeItem;
	}

	getChildren() {
		const items = [];
		// 搜索模式下且存在更多结果时，在列表顶部提供分页切换
		if (this.searchKeyword && this.searchTotal > FEED_DISPLAY_LIMIT) {
			if (this.hasPrevPage()) {
				items.push({ isPagination: true, direction: 'prev' });
			}
			if (this.hasNextPage()) {
				items.push({ isPagination: true, direction: 'next' });
			}
		}
		// 首次加载/刷新中给占位提示，避免列表空白
		if (this.videoEntries.length === 0 && this.isLoading) {
			const loading = new vscode.TreeItem('正在加载推荐视频…', vscode.TreeItemCollapsibleState.None);
			loading.iconPath = new vscode.ThemeIcon('sync~spin');
			items.push(loading);
			return Promise.resolve(items);
		}
		items.push(...this.videoEntries);
		return Promise.resolve(items);
	}
}

/** 接口不可用时展示的内置示例数据（本地占位，不可实际播放） */
function createFallbackEntries() {
	return [
		new VideoEntry({
			bvid: '',
			title: '示例视频：接口暂时不可用，请稍后刷新',
			uploader: '本地占位',
			durationSec: 0,
			summary: '网络或接口异常时的占位条目，配置 Cookie 后点击标题栏刷新即可加载真实推荐。',
		}),
	];
}

/** Cookie 设置引导弹窗 */
async function promptCookieSetup(message) {
	const action = await vscode.window.showWarningMessage(message, '设置 Cookie');
	if (action === '设置 Cookie') {
		await inputAndSaveCookie();
	}
}

/** 输入并保存 Cookie */
async function inputAndSaveCookie() {
	const cookie = await vscode.window.showInputBox({
		prompt: '请输入B站账号 Cookie（浏览器开发者工具 → Network → 请求头中的 Cookie 值）',
		placeHolder: 'SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx; ...',
		password: true,
		ignoreFocusOut: true,
	});
	if (cookie === undefined) {
		return;
	}
	await updateGlobalConfig('userCookie', cookie.trim());
	vscode.window.showInformationMessage(
		cookie.trim() ? 'Cookie 已保存，推荐列表将按账号个性化加载' : 'Cookie 已清空，将使用随机推荐'
	);
}

/** 输入并保存抖音 Cookie（推荐流/关注流均需登录态） */
async function inputAndSaveDouyinCookie() {
	const cookie = await vscode.window.showInputBox({
		prompt: '请输入抖音账号 Cookie（浏览器打开 douyin.com 登录后，开发者工具 → Network → 请求头中的 Cookie 值）',
		placeHolder: 'ttwid=xxx; sessionid_ss=xxx; sid_tt=xxx; ...',
		password: true,
		ignoreFocusOut: true,
	});
	if (cookie === undefined) {
		return;
	}
	await updateGlobalConfig('douyinCookie', cookie.trim());
	vscode.window.showInformationMessage(
		cookie.trim() ? '抖音 Cookie 已保存，进入「抖音视界」即可加载推荐与关注' : '抖音 Cookie 已清空'
	);
}

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
			const workerPath = path.join(__dirname, 'dy-fetch-worker.js');
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

// ---------- 抖音：伪装模式侧边栏列表（与 B站伪装列表同款：文件样式图标 + 点击在编辑区打开伪装面板；支持搜索） ----------
class DouyinListProvider {
	constructor(douyinClient, listIconUri) {
		this.douyinClient = douyinClient;
		this.listIconUri = listIconUri;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
		this.entries = [];
		this.isLoading = false;
		// 空列表状态：needCookie（未配置 Cookie）/ error（请求失败）/ empty（无数据）
		// / searchVerify（搜索被风控 verify_check）/ searchEmpty（搜索无结果）
		this.state = '';
		this.errorMsg = '';
		// 搜索状态：非空 keyword 表示当前处于搜索结果模式
		this.searchKeyword = '';
		this.searchOffset = 0;
		this.hasMoreSearch = false;
	}

	/** 刷新：搜索模式下重搜当前关键词，否则重载推荐 */
	reloadFeed() {
		if (this.searchKeyword) {
			return this.searchByKeyword(this.searchKeyword);
		}
		return this.loadRecommendVideos();
	}

	/** 退出搜索回到推荐流 */
	exitSearch() {
		this.searchKeyword = '';
		this.searchOffset = 0;
		this.hasMoreSearch = false;
		return this.loadRecommendVideos();
	}

	/** 搜索失败（如 verify_check）后用当前关键词重试 */
	retrySearch() {
		if (!this.searchKeyword) {
			return this.loadRecommendVideos();
		}
		return this.searchByKeyword(this.searchKeyword);
	}

	/** 加载推荐流：连取两页（每页 10 条）按 awemeId 去重，凑够列表长度 */
	async loadRecommendVideos() {
		if (this.isLoading) {
			return;
		}
		this.isLoading = true;
		this.state = 'loading';
		this.errorMsg = '';
		this._onDidChangeTreeData.fire();
		try {
			const merged = [];
			const seen = new Set();
			for (const refreshIndex of [1, 2]) {
				const { entries } = await this.douyinClient.getFeed(refreshIndex);
				for (const entry of entries) {
					if (entry.awemeId && !seen.has(entry.awemeId)) {
						seen.add(entry.awemeId);
						merged.push(entry);
					}
				}
				// 第一页拿不到数据时没必要再翻第二页
				if (merged.length === 0) {
					break;
				}
			}
			this.entries = merged;
			this.state = merged.length === 0 ? 'empty' : '';
		} catch (error) {
			this.entries = [];
			this.state = error && error.needCookie ? 'needCookie' : 'error';
			this.errorMsg = error instanceof Error ? error.message : String(error);
			console.error('[bili-hover-viewer] 加载抖音推荐列表失败:', error);
		} finally {
			this.isLoading = false;
			this._onDidChangeTreeData.fire();
		}
	}

	/** 关键词搜索（首批，offset 归零） */
	async searchByKeyword(keyword) {
		const trimmed = String(keyword || '').trim();
		if (!trimmed || this.isLoading) {
			return;
		}
		this.isLoading = true;
		this.searchKeyword = trimmed;
		this.searchOffset = 0;
		this.hasMoreSearch = false;
		this.state = 'searchLoading';
		this.errorMsg = '';
		this._onDidChangeTreeData.fire();
		try {
			const { entries, hasMore, offset } = await this.douyinClient.search(trimmed, 0);
			this.entries = entries;
			this.searchOffset = offset;
			this.hasMoreSearch = hasMore;
			this.state = entries.length === 0 ? 'searchEmpty' : '';
		} catch (error) {
			this.entries = [];
			this.hasMoreSearch = false;
			if (error && error.verifyRequired) {
				this.state = 'searchVerify';
				this.errorMsg = error.message;
				vscode.window.showWarningMessage('抖音搜索需要人机验证：请在浏览器完成一次搜索验证后点击列表中的重试项');
			} else if (error && error.needCookie) {
				this.state = 'needCookie';
				this.errorMsg = error.message;
			} else {
				this.state = 'error';
				this.errorMsg = error instanceof Error ? error.message : String(error);
			}
			console.error('[bili-hover-viewer] 抖音列表搜索失败:', error);
		} finally {
			this.isLoading = false;
			this._onDidChangeTreeData.fire();
		}
	}

	/** 加载更多搜索结果（offset 翻页追加，按 awemeId 去重） */
	async loadMoreSearch() {
		if (this.isLoading || !this.searchKeyword || !this.hasMoreSearch) {
			return;
		}
		this.isLoading = true;
		this._onDidChangeTreeData.fire();
		try {
			const { entries, hasMore, offset } = await this.douyinClient.search(this.searchKeyword, this.searchOffset);
			const known = new Set(this.entries.map((item) => item.awemeId));
			for (const entry of entries) {
				if (entry.awemeId && !known.has(entry.awemeId)) {
					known.add(entry.awemeId);
					this.entries.push(entry);
				}
			}
			this.searchOffset = offset;
			this.hasMoreSearch = hasMore;
			this.state = this.entries.length === 0 ? 'searchEmpty' : '';
		} catch (error) {
			// 翻页失败不清空已有结果，仅提示
			this.hasMoreSearch = false;
			vscode.window.showErrorMessage(`搜索翻页失败：${error instanceof Error ? error.message : '未知错误'}`);
		} finally {
			this.isLoading = false;
			this._onDidChangeTreeData.fire();
		}
	}

	getTreeItem(entry) {
		// 控制/占位节点
		if (entry && entry.dyControl) {
			const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon(entry.icon || 'info');
			if (entry.command) {
				item.command = entry.command;
			}
			if (entry.tooltip) {
				item.tooltip = entry.tooltip;
			}
			return item;
		}
		// 空列表占位节点（未配置 Cookie / 加载中 / 失败 / 空）
		if (entry && entry.dyPlaceholder) {
			const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon(entry.icon || 'info');
			if (entry.command) {
				item.command = entry.command;
			}
			if (entry.tooltip) {
				item.tooltip = entry.tooltip;
			}
			return item;
		}
		const treeItem = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
		treeItem.description = `@${entry.author} · ${entry.durationText}`;
		treeItem.tooltip = new vscode.MarkdownString(
			[
				`**${entry.title}**`,
				`作者：@${entry.author}`,
				`时长：${entry.durationText}　点赞：${formatCount(entry.digg)}　评论：${formatCount(entry.comment)}　分享：${formatCount(entry.share)}`,
			].join('\n')
		);
		// 与 B站伪装列表一致使用代码文件图标，让侧边栏看起来像文件列表
		treeItem.iconPath = this.listIconUri;
		treeItem.command = {
			command: 'biliHover.douyinPlaySelected',
			title: '播放该抖音视频',
			arguments: [entry],
		};
		return treeItem;
	}

	getChildren() {
		// ----- 搜索结果模式 -----
		if (this.searchKeyword) {
			const controls = [{
				dyControl: true,
				label: `◀ 返回推荐（当前搜索：${this.searchKeyword}）`,
				icon: 'arrow-left',
				command: { command: 'biliHover.douyinExitSearch', title: '返回抖音推荐' },
			}];
			if (this.state === 'searchLoading') {
				controls.push({ dyPlaceholder: true, label: '正在搜索…', icon: 'sync~spin' });
				return Promise.resolve(controls);
			}
			if (this.state === 'searchVerify') {
				controls.push({
					dyPlaceholder: true,
					label: '搜索需要人机验证（点击重试，或先去浏览器完成验证）',
					icon: 'pass',
					tooltip: '抖音对搜索接口有额外风控：浏览器打开抖音搜索一次完成验证后，点此重试',
					command: { command: 'biliHover.douyinSearchRetry', title: '重试搜索' },
				});
				return Promise.resolve(controls);
			}
			if (this.state === 'searchEmpty') {
				controls.push({ dyPlaceholder: true, label: '未找到相关视频，换个关键词试试', icon: 'search-stop' });
				return Promise.resolve(controls);
			}
			if (this.state === 'needCookie') {
				controls.push({
					dyPlaceholder: true,
					label: '请先设置抖音 Cookie（点击配置）',
					icon: 'key',
					command: { command: 'biliHover.douyinSetCookie', title: '设置抖音Cookie' },
				});
				return Promise.resolve(controls);
			}
			if (this.state === 'error') {
				controls.push({
					dyPlaceholder: true,
					label: `搜索失败：${this.errorMsg || '未知错误'}（点击重试）`,
					icon: 'error',
					command: { command: 'biliHover.douyinSearchRetry', title: '重试搜索' },
				});
				return Promise.resolve(controls);
			}
			if (this.hasMoreSearch) {
				controls.push({
					dyControl: true,
					label: this.isLoading ? '正在加载更多…' : '▶ 加载更多搜索结果',
					icon: this.isLoading ? 'sync~spin' : 'chevron-down',
					command: { command: 'biliHover.douyinSearchMore', title: '加载更多搜索结果' },
				});
			}
			controls.push(...this.entries);
			return Promise.resolve(controls);
		}

		// ----- 推荐流模式 -----
		// 首次展开（尚未加载、无错误且不在加载中）时自动拉取推荐流
		if (this.entries.length === 0 && !this.isLoading && this.state === '') {
			this.loadRecommendVideos();
		}
		if (this.entries.length === 0) {
			if (this.isLoading || this.state === 'loading') {
				return Promise.resolve([{
					dyPlaceholder: true,
					label: '正在加载抖音推荐…',
					icon: 'sync~spin',
				}]);
			}
			if (this.state === 'needCookie') {
				return Promise.resolve([{
					dyPlaceholder: true,
					label: '请先设置抖音 Cookie（点击配置）',
					icon: 'key',
					tooltip: '推荐流需要登录态 Cookie，点击此处打开输入框',
					command: { command: 'biliHover.douyinSetCookie', title: '设置抖音Cookie' },
				}]);
			}
			if (this.state === 'error') {
				return Promise.resolve([{
					dyPlaceholder: true,
					label: `加载失败：${this.errorMsg || '未知错误'}（点击刷新）`,
					icon: 'error',
					command: { command: 'biliHover.douyinRefresh', title: '刷新抖音推荐' },
				}]);
			}
			if (this.state === 'empty') {
				return Promise.resolve([{
					dyPlaceholder: true,
					label: '暂无推荐内容（点击刷新）',
					icon: 'info',
					command: { command: 'biliHover.douyinRefresh', title: '刷新抖音推荐' },
				}]);
			}
		}
		return Promise.resolve(this.entries);
	}
}

// ---------- 抖音：竖向沉浸式视频流视图 ----------
class DouyinFeedView {
	constructor(douyinClient, mediaProxy, context) {
		this.douyinClient = douyinClient;
		this.mediaProxy = mediaProxy;
		this.context = context;
		this.view = null;
		this.entryCache = new Map(); // awemeId → DouyinEntry（播放解析按 id 查找）
		this.refreshIndex = 1; // 推荐流游标
		this.followMaxCursor = 0; // 关注流游标
		this.hasMoreFollowing = true;
		this.feedLoading = false;
		this.followingLoading = false;
		// 搜索状态：keyword + offset 分页 + 验证引导
		this.searchKeyword = '';
		this.searchOffset = 0;
		this.hasMoreSearch = false;
		this.searchLoading = false;
		this.searchSeq = 0; // 搜索请求序号：新关键词打断旧请求时丢弃过期响应
	}

	resolveWebviewView(webviewView) {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
		webviewView.webview.html = this.buildHtml();
		webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
		webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = null;
			}
		});
	}

	/** 页面 HTML：抖音风格竖滑模板 + 配置注入 */
	buildHtml() {
		const template = loadWebviewTemplate(this.context, 'douyin.html');
		return applyTemplate(template, {
			__AUTO_PLAY__: readConfig('douyinAutoPlay', true) ? '1' : '0',
			__VOLUME__: JSON.stringify(readConfig('douyinVolume', 0.5)),
		});
	}

	cacheEntries(entries) {
		for (const entry of entries) {
			if (entry && entry.awemeId) {
				this.entryCache.set(entry.awemeId, entry);
			}
		}
		// 上限回收：防止长列表内存膨胀（缓存淘汰不影响已渲染的 <video> 元素）
		if (this.entryCache.size > DY_MAX_LIST_SIZE * 2) {
			const keys = Array.from(this.entryCache.keys()).slice(0, this.entryCache.size - DY_MAX_LIST_SIZE * 2);
			for (const key of keys) {
				this.entryCache.delete(key);
			}
		}
	}

	async postToView(message) {
		if (!this.view) {
			return;
		}
		try {
			await this.view.webview.postMessage(message);
		} catch (error) {
			// webview 已销毁时忽略
		}
	}

	async handleMessage(message) {
		if (!message || typeof message.command !== 'string') {
			return;
		}
		switch (message.command) {
			case 'dy:requestFeed':
				await this.loadFeed(Boolean(message.reset));
				break;
			case 'dy:requestFollowing':
				await this.loadFollowing(Boolean(message.reset));
				break;
			case 'dy:requestSearch':
				await this.loadSearch(String(message.keyword || ''), Boolean(message.reset));
				break;
			case 'dy:openSearchSite': {
				// 搜索被风控（verify_check）时，引导用户去浏览器完成一次搜索验证
				const keyword = String(message.keyword || this.searchKeyword || '').trim();
				const target = keyword
					? `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`
					: 'https://www.douyin.com';
				await vscode.env.openExternal(vscode.Uri.parse(target));
				break;
			}
			case 'dy:requestPlay':
				await this.resolvePlay(message.awemeId, message.retryIndex || 0);
				break;
			case 'dy:openOnSite': {
				const url = typeof message.url === 'string' && message.url
					? message.url
					: (this.entryCache.get(message.awemeId) || {}).pageUrl;
				if (url) {
					await vscode.env.openExternal(vscode.Uri.parse(url));
				}
				break;
			}
			case 'dy:openCookieInput':
				await inputAndSaveDouyinCookie();
				break;
			default:
				break;
		}
	}

	/** 推荐流：reset 表示刷新重建（游标归 1），否则游标递增追加 */
	async loadFeed(reset) {
		if (this.feedLoading) {
			return;
		}
		if (reset) {
			this.refreshIndex = 1;
		}
		this.feedLoading = true;
		try {
			const { entries } = await this.douyinClient.getFeed(this.refreshIndex);
			this.refreshIndex += 1;
			this.cacheEntries(entries);
			await this.postToView({
				command: 'dy:feedData',
				reset,
				entries: entries.map((entry) => entry.serialize()),
			});
		} catch (error) {
			await this.postFeedError('dy:feedData', error);
		} finally {
			this.feedLoading = false;
		}
	}

	/** 关注流：max_cursor 游标分页 */
	async loadFollowing(reset) {
		if (this.followingLoading) {
			return;
		}
		if (reset) {
			this.followMaxCursor = 0;
			this.hasMoreFollowing = true;
		}
		if (!this.hasMoreFollowing) {
			await this.postToView({ command: 'dy:followingData', reset, entries: [], hasMore: false });
			return;
		}
		this.followingLoading = true;
		try {
			const { entries, hasMore, maxCursor } = await this.douyinClient.getFollowing(this.followMaxCursor);
			this.followMaxCursor = hasMore && maxCursor ? maxCursor : this.followMaxCursor;
			this.hasMoreFollowing = hasMore;
			this.cacheEntries(entries);
			await this.postToView({
				command: 'dy:followingData',
				reset,
				entries: entries.map((entry) => entry.serialize()),
				hasMore,
			});
		} catch (error) {
			await this.postFeedError('dy:followingData', error);
		} finally {
			this.followingLoading = false;
		}
	}

	/** 统一错误推送：无 Cookie 场景带 needCookie 标记，前端引导设置；搜索风控带 verifyRequired */
	async postFeedError(command, error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		console.error('[bili-hover-viewer] 加载抖音数据失败:', error);
		await this.postToView({
			command,
			reset: false,
			entries: [],
			hasMore: false,
			error: errMsg,
			needCookie: Boolean(error && error.needCookie),
			verifyRequired: Boolean(error && error.verifyRequired),
			keyword: error && error.keyword ? error.keyword : this.searchKeyword,
		});
	}

	/**
	 * 搜索：reset 表示新关键词（游标归零），否则用当前 offset 翻页。
	 * 搜索接口风控较严（verify_check），错误经 dy:searchData 透传 verifyRequired 给前端引导。
	 */
	async loadSearch(keyword, reset) {
		const trimmed = String(keyword || '').trim();
		if (!trimmed) {
			return;
		}
		const isNewSearch = reset || trimmed !== this.searchKeyword;
		// 同关键词翻页防重入；新关键词搜索允许打断进行中的旧请求
		if (this.searchLoading && !isNewSearch) {
			return;
		}
		if (isNewSearch) {
			this.searchKeyword = trimmed;
			this.searchOffset = 0;
			this.hasMoreSearch = true;
		}
		if (!this.hasMoreSearch) {
			await this.postToView({ command: 'dy:searchData', reset: false, entries: [], hasMore: false, keyword: trimmed });
			return;
		}
		const seq = ++this.searchSeq;
		this.searchLoading = true;
		try {
			const { entries, hasMore, offset } = await this.douyinClient.search(this.searchKeyword, this.searchOffset);
			if (seq !== this.searchSeq) {
				return; // 已被更新的搜索取代，丢弃过期响应
			}
			this.searchOffset = offset;
			this.hasMoreSearch = hasMore;
			this.cacheEntries(entries);
			await this.postToView({
				command: 'dy:searchData',
				reset: this.searchOffset === 10, // 首批（offset 归零后的第一页）
				entries: entries.map((entry) => entry.serialize()),
				hasMore,
				keyword: this.searchKeyword,
			});
		} catch (error) {
			if (seq !== this.searchSeq) {
				return;
			}
			await this.postFeedError('dy:searchData', error);
		} finally {
			if (seq === this.searchSeq) {
				this.searchLoading = false;
			}
		}
	}

	/** 播放地址解析：本地代理包装 mp4 直链（HLS 一期内播不支持，回退站外打开）；retryIndex 供前端播放失败时换下一个直链 */
	async resolvePlay(awemeId, retryIndex) {
		const entry = this.entryCache.get(awemeId);
		if (!entry) {
			await this.postToView({
				command: 'dy:playResolved',
				awemeId,
				url: '',
				error: '视频数据不存在或已失效，请刷新重试',
			});
			return;
		}
		const directUrls = entry.playUrls.filter((url) => !/\.m3u8/i.test(url));
		const index = Math.max(0, Number(retryIndex) || 0);
		const directUrl = directUrls[index] || '';
		if (!directUrl || !this.mediaProxy.port) {
			await this.postToView({
				command: 'dy:playResolved',
				awemeId,
				url: '',
				pageUrl: entry.pageUrl,
				error: '该视频暂无可直接播放的流，请在浏览器打开',
			});
			return;
		}
		await this.postToView({
			command: 'dy:playResolved',
			awemeId,
			url: this.mediaProxy.localUrl(directUrl),
			retryIndex: index,
		});
	}

	/** Cookie 变更：清空缓存与游标，通知页面重置并重新加载当前 tab */
	async handleCookieChanged() {
		this.entryCache.clear();
		this.refreshIndex = 1;
		this.followMaxCursor = 0;
		this.hasMoreFollowing = true;
		// 重置 loading 标志：避免改 Cookie 瞬间恰有请求在飞时，新请求被防重入拦截导致前端卡在加载态
		this.feedLoading = false;
		this.followingLoading = false;
		this.searchLoading = false;
		this.searchKeyword = '';
		this.searchOffset = 0;
		this.hasMoreSearch = false;
		await this.postToView({ command: 'dy:cookieChanged', hasCookie: Boolean(this.douyinClient.userCookie) });
	}

	/** 命令入口：刷新（页面重置并重拉当前 tab） */
	async reload() {
		await this.postToView({ command: 'dy:cmdReload' });
	}

	/** 命令入口：上一个/下一个视频 */
	async navigate(dir) {
		await this.postToView({ command: 'dy:cmdNavigate', dir: dir === 'prev' ? 'prev' : 'next' });
	}
}

// ---------- 不伪装模式：仿B站视频流页面（卡片流 + 底部悬浮播放条） ----------
class DisguiseFeedView {
	constructor(sidebarProvider, feedClient, context) {
		this.sidebarProvider = sidebarProvider;
		this.feedClient = feedClient;
		this.context = context;
		this.view = null;
		// 全部分区条目缓存：feed:play 时按 bvid 查找（含推荐/热门/动态/待看等各分区数据）
		this.entryCache = new Map();
		// 扫码登录轮询状态
		this.loginPollTimer = null;
		this.loginQrcodeKey = '';
		// 分区加载状态：待看全量缓存
		this.watchLaterEntries = [];
		// 直播已展示房间号集合（index/getList 无翻页，靠重复请求轮换取新房间去重）
		this.liveSeenRoomIds = new Set();
	}

	resolveWebviewView(webviewView) {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
		webviewView.webview.html = this.buildHtml();
		webviewView.webview.onDidReceiveMessage((message) => this.handleMessage(message));
		this.pushUserInfo();
		// 主动同步一次：视图切换（伪装开关）后立即把当前列表写入 entryCache，
		// 不依赖页面加载完成后的 feed:requestEntries，避免点击卡片时查不到数据
		this.pushEntries();
		webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = null;
			}
			this.stopLoginPolling();
		});
	}

	/** 向页面推送登录用户信息（头像/昵称，用于顶栏右侧展示） */
	async pushUserInfo() {
		const user = await this.feedClient.fetchUserInfo();
		await this.postToView({ command: 'feed:userInfo', user });
	}

	/** 页面 HTML：读取不伪装模式的视频流页面模板并注入配置与 hls.js（直播播放依赖） */
	buildHtml() {
		const template = loadWebviewTemplate(this.context, 'feed.html');
		let hlsLib = '';
		try {
			hlsLib = fs.readFileSync(path.join(this.context.extensionUri.fsPath, 'webview', 'hls.light.min.js'), 'utf8');
			// 防止库代码中出现闭合 script 标签截断页面（下载时已验证无此内容，此处兜底转义）
			hlsLib = hlsLib.replace(/<\/script/gi, '<\\/script');
		} catch (error) {
			console.error('[bili-hover-viewer] 读取 hls.js 失败（直播将无法播放）:', error);
		}
		// 注意替换顺序：先普通配置占位符，最后注入 hls 库代码，避免库内容被占位符误替换
		return applyTemplate(template, {
			__AUTO_START__: readConfig('autoStartPlayback', true) ? 'autoplay' : '',
			__VOLUME__: JSON.stringify(readConfig('initialVolume', 0.5)),
			__HLS_LIB__: hlsLib,
		});
	}

	findEntry(bvid) {
		return this.entryCache.get(bvid) ||
			this.sidebarProvider.videoEntries.find((item) => item.bvid && item.bvid === bvid) ||
			null;
	}

	/** 将条目写入分区缓存 */
	cacheEntries(entries) {
		for (const entry of entries) {
			if (entry && entry.bvid) {
				this.entryCache.set(entry.bvid, entry);
			}
		}
	}

	/** 向页面推送当前视频条目（页面未创建时跳过） */
	async pushEntries() {
		if (!this.view) {
			return;
		}
		const provider = this.sidebarProvider;
		if (provider.videoEntries.length === 0 && provider.isLoading) {
			return; // 首次加载中，保留页面上的加载提示
		}
		this.cacheEntries(provider.videoEntries);
		await this.postToView({
			command: 'feed:entries',
			entries: provider.videoEntries.map(serializeEntry),
			meta: {
				searchMode: Boolean(provider.searchKeyword),
				page: provider.searchPage,
				totalPages: provider.totalSearchPages(),
				canPrev: provider.hasPrevPage(),
				canNext: provider.hasNextPage(),
			},
		});
	}

	async postToView(message) {
		if (!this.view) {
			return;
		}
		try {
			await this.view.webview.postMessage(message);
		} catch (error) {
			// webview 已销毁时忽略
		}
	}

	async handleMessage(message) {
		if (!message || typeof message.command !== 'string') {
			return;
		}
		switch (message.command) {
			case 'feed:requestEntries':
				await this.pushEntries();
				break;
			case 'feed:prevPage':
				this.sidebarProvider.gotoPrevPage();
				break;
			case 'feed:nextPage':
				await this.sidebarProvider.gotoNextPage();
				break;
			case 'feed:refresh':
				await this.sidebarProvider.reloadFeed();
				break;
			case 'feed:play':
				await this.playEntry(message.bvid);
				break;
			case 'feed:playLive':
				await this.playLiveEntry(message.roomId);
				break;
			case 'feed:addViewLater':
				await this.addViewLaterEntry(message.bvid);
				break;
			case 'feed:openOnSite': {
				// 支持直接传 url（直播房间），否则按 bvid 查缓存条目
				let url = typeof message.url === 'string' ? message.url : '';
				if (!url) {
					const entry = this.findEntry(message.bvid);
					url = entry && entry.pageUrl;
				}
				if (url) {
					await vscode.env.openExternal(vscode.Uri.parse(url));
				}
				break;
			}
			case 'feed:loadTab':
				await this.handleLoadTab(message);
				break;
			case 'feed:loginStart':
				await this.handleLoginStart();
				break;
			case 'feed:loginCancel':
				this.stopLoginPolling();
				break;
			case 'feed:logout':
				await this.handleLogout();
				break;
			default:
				break;
		}
	}

	// ----- 分区加载（热门 / 直播 / 动态 / 待看） -----

	/** 处理页面分区加载请求：返回 feed:tabData（append 表示追加到已加载数据之后） */
	async handleLoadTab(message) {
		const tab = message.tab;
		const page = Math.max(1, Number(message.page) || 1);
		const append = Boolean(message.append);
		try {
			let payload = { tab, page, append, entries: [], hasMore: false, offset: '' };
			if (tab === 'popular') {
				const entries = await this.feedClient.fetchPopularVideos(page);
				this.cacheEntries(entries);
				payload.entries = entries.map(serializeEntry);
				payload.hasMore = entries.length >= 20;
			} else if (tab === 'live') {
				// index/getList 无翻页，但推荐位每次请求都会轮换：
				// 首次加载重置已见集合取全量；追加时重复请求 2 轮，仅返回未展示过的新直播间
				if (!append) {
					this.liveSeenRoomIds = new Set();
				}
				const fresh = [];
				for (let i = 0; i < (append ? 2 : 1); i++) {
					const batch = await this.feedClient.fetchLiveRooms(this.liveSeenRoomIds);
					for (const room of batch) {
						this.liveSeenRoomIds.add(room.roomId);
						fresh.push(room);
					}
				}
				payload.entries = fresh.map(serializeLiveRoom);
				payload.hasMore = fresh.length > 0;
			} else if (tab === 'watchlater') {
				if (!this.feedClient.userCookie) {
					payload.needLogin = true;
				} else {
					if (!append || this.watchLaterEntries.length === 0) {
						this.watchLaterEntries = await this.feedClient.fetchWatchLaterVideos();
						this.cacheEntries(this.watchLaterEntries);
					}
					const start = (page - 1) * WATCHLATER_PAGE_SIZE;
					payload.entries = this.watchLaterEntries.slice(start, start + WATCHLATER_PAGE_SIZE).map(serializeEntry);
					payload.hasMore = start + WATCHLATER_PAGE_SIZE < this.watchLaterEntries.length;
				}
			} else {
				payload.error = '未知分区';
			}
			await this.postToView({ command: 'feed:tabData', ...payload });
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			const apiCode = error && error.apiCode;
			console.error(`[bili-hover-viewer] 加载分区 ${tab} 失败:`, error);
			await this.postToView({
				command: 'feed:tabData',
				tab,
				page,
				append,
				entries: [],
				hasMore: false,
				offset: '',
				error: errMsg + (apiCode ? `（code ${apiCode}）` : ''),
				needLogin: !this.feedClient.userCookie || isCookieExpiredCode(apiCode),
			});
		}
	}

	// ----- 扫码登录 -----

	/** 开始扫码登录：生成二维码并启动轮询 */
	async handleLoginStart() {
		this.stopLoginPolling();
		try {
			const { qrcodeKey, qrImageUrl } = await this.feedClient.generateLoginQrcode();
			this.loginQrcodeKey = qrcodeKey;
			await this.postToView({ command: 'feed:loginQr', qrImageUrl });
			this.loginPollTimer = setInterval(() => {
				this.pollLoginStatus();
			}, LOGIN_POLL_INTERVAL_MS);
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error('[bili-hover-viewer] 获取登录二维码失败:', error);
			await this.postToView({ command: 'feed:loginError', message: errMsg });
		}
	}

	/** 轮询扫码状态：成功保存 Cookie，过期自动刷新二维码 */
	async pollLoginStatus() {
		if (!this.loginQrcodeKey) {
			return;
		}
		let result;
		try {
			result = await this.feedClient.pollLoginQrcode(this.loginQrcodeKey);
		} catch (error) {
			console.error('[bili-hover-viewer] 查询扫码状态失败:', error);
			return; // 网络抖动时下一轮继续
		}
		if (result.state === QR_STATE_SUCCESS) {
			this.stopLoginPolling();
			const cookies = result.cookies;
			if (!cookies) {
				await this.postToView({ command: 'feed:loginError', message: '登录成功但未取到登录态，请重试' });
				return;
			}
			await updateGlobalConfig('userCookie', cookies);
			vscode.window.showInformationMessage('B站扫码登录成功，推荐列表将按账号个性化加载');
			await this.pushUserInfo();
			await this.postToView({ command: 'feed:loginSuccess' });
		} else if (result.state === QR_STATE_EXPIRED) {
			// 二维码过期：自动重新生成
			await this.handleLoginStart();
		} else if (result.state === QR_STATE_CONFIRMED) {
			await this.postToView({ command: 'feed:loginState', state: 'confirmed' });
		} else if (result.state === QR_STATE_NOT_SCANNED) {
			await this.postToView({ command: 'feed:loginState', state: 'waiting' });
		}
	}

	/** 停止轮询并清理登录状态 */
	stopLoginPolling() {
		if (this.loginPollTimer) {
			clearInterval(this.loginPollTimer);
			this.loginPollTimer = null;
		}
		this.loginQrcodeKey = '';
	}

	/** 退出登录：清空 Cookie 配置（配置监听会自动刷新推荐列表） */
	async handleLogout() {
		this.stopLoginPolling();
		await updateGlobalConfig('userCookie', '');
		await this.pushUserInfo();
		vscode.window.showInformationMessage('已退出登录，将使用随机推荐');
	}

	/** 解析播放流并推送给页面 */
	async playEntry(requestBvid) {
		const entry = this.findEntry(requestBvid);
		if (!entry) {
			// 旧版本此处静默返回导致点击无任何反应；现在明确提示（典型场景：视图切换后缓存未同步）
			const errMsg = '视频数据不存在或已失效，请点击右下角刷新按钮重新加载';
			console.warn('[bili-hover-viewer] playEntry 未找到条目:', requestBvid);
			await this.postToView({
				command: 'feed:playerError',
				bvid: requestBvid,
				message: errMsg,
			});
			return;
		}
		try {
			const { streamUrls, qualityLabel } = await this.feedClient.resolvePlayStream(entry);
			await this.postToView({
				command: 'feed:playerData',
				entry: serializeEntry(entry),
				streamUrls,
				qualityLabel,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			const apiCode = error && error.apiCode;
			console.error('[bili-hover-viewer] 解析播放地址失败:', { message: errMsg, apiCode });
			vscode.window.showErrorMessage(`B站视频加载失败：${errMsg}${apiCode ? `（code ${apiCode}）` : ''}`);
			await this.postToView({
				command: 'feed:playerError',
				bvid: requestBvid,
				message: errMsg + (apiCode ? ` [code ${apiCode}]` : ''),
				cookieExpired: isCookieExpiredCode(apiCode),
			});
		}
	}

	/** 解析直播 HLS 流并推送给页面（原位播放，webview 内用 hls.js 挂载） */
	async playLiveEntry(requestRoomId) {
		if (!requestRoomId) {
			return;
		}
		try {
			const { streamUrls } = await this.feedClient.resolveLiveStream(requestRoomId);
			await this.postToView({
				command: 'feed:liveStreamReady',
				roomId: requestRoomId,
				streamUrls,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			const apiCode = error && error.apiCode;
			console.error('[bili-hover-viewer] 解析直播流失败:', { message: errMsg, apiCode });
			vscode.window.showErrorMessage(`直播加载失败：${errMsg}${apiCode ? `（code ${apiCode}）` : ''}`);
			await this.postToView({
				command: 'feed:liveStreamError',
				roomId: requestRoomId,
				message: errMsg + (apiCode ? ` [code ${apiCode}]` : ''),
			});
		}
	}

	/** 加入稍后再看并推送结果提示 */
	async addViewLaterEntry(requestBvid) {
		try {
			await this.feedClient.addToViewLater(requestBvid);
			await this.postToView({
				command: 'feed:viewLaterResult',
				ok: true,
				bvid: requestBvid,
				message: '已加入稍后再看',
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			const apiCode = error && error.apiCode;
			console.error('[bili-hover-viewer] 加入稍后再看失败:', { message: errMsg, apiCode });
			await this.postToView({
				command: 'feed:viewLaterResult',
				ok: false,
				bvid: requestBvid,
				message: errMsg + (apiCode ? ` [code ${apiCode}]` : ''),
			});
		}
	}

	/** 不伪装模式随机播放：通知视频流页面在底部播放条中播放 */
	async playRandomInWebview(bvid) {
		await this.postToView({ command: 'feed:playRequest', bvid });
	}
}

// ---------- 编辑区播放面板（伪装模式：遮罩聚焦显示；不伪装模式：直接显示画面） ----------
class HoverVideoPane {
	constructor(context, feedClient) {
		this.context = context;
		this.feedClient = feedClient;
		this.pane = null;
		this.currentEntry = null;
	}

	/** 面板标题：伪装模式伪装成代码文件名，不伪装模式用直白的视频标题 */
	currentTitle() {
		return readConfig('disguiseEnabled', true)
			? (readConfig('playerPaneTitle', DEFAULT_PANE_TITLE) || DEFAULT_PANE_TITLE)
			: DEFAULT_OPEN_PANE_TITLE;
	}

	async show(entry) {
		// 树点击跨进程传递后 entry 会退化为普通对象（丢失 getter），此处统一重建
		if (!(entry instanceof VideoEntry)) {
			entry = new VideoEntry(entry);
		}
		this.currentEntry = entry;
		const paneTitle = this.currentTitle();
		if (this.pane) {
			this.pane.title = paneTitle;
			this.pane.reveal(vscode.ViewColumn.One);
			await this.renderPane(entry);
			return;
		}
		this.pane = vscode.window.createWebviewPanel('biliHoverVideoPane', paneTitle, vscode.ViewColumn.One, {
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [],
			}
		);
		this.pane.webview.onDidReceiveMessage(
			(message) => this.handlePaneMessage(message),
			undefined,
			this.context.subscriptions
		);
		this.pane.onDidDispose(
			() => {
				this.pane = null;
				this.currentEntry = null;
			},
			undefined,
			this.context.subscriptions
		);
		await this.renderPane(entry);
	}

	async handlePaneMessage(message) {
		if (!message || typeof message.command !== 'string') {
			return;
		}
		switch (message.command) {
			case 'pane:requestStream':
				await this.deliverStream(message.videoBvid);
				break;
			case 'pane:openOnSite':
				if (this.currentEntry && this.currentEntry.pageUrl) {
					await vscode.env.openExternal(vscode.Uri.parse(this.currentEntry.pageUrl));
				}
				break;
			case 'pane:persistWidth': {
				const width = Number(message.width);
				if (Number.isFinite(width) && width >= 200 && width <= 1200) {
					await updateGlobalConfig('playerPaneWidth', Math.round(width));
				}
				break;
			}
			default:
				break;
		}
	}

	/** 响应面板的取流请求 */
	async deliverStream(requestBvid) {
		const entry = this.currentEntry;
		if (!entry || !this.pane) {
			return;
		}
		if (requestBvid && entry.bvid && requestBvid !== entry.bvid) {
			return; // 面板已切换视频，丢弃过期请求
		}
		try {
			const { streamUrls, qualityLabel } = await this.feedClient.resolvePlayStream(entry);
			if (this.pane) {
				await this.pane.webview.postMessage({
					command: 'pane:streamReady',
					streamUrls,
					qualityLabel,
				});
			}
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			const apiCode = error && error.apiCode;
			console.error('[bili-hover-viewer] 解析播放地址失败:', { message: errMsg, apiCode });
			// 同时在编辑器内弹通知，避免面板被关闭时看不到原因
			vscode.window.showErrorMessage(`B站视频加载失败：${errMsg}${apiCode ? `（code ${apiCode}）` : ''}`);
			if (this.pane) {
				await this.pane.webview.postMessage({
					command: 'pane:streamError',
					message: errMsg + (apiCode ? ` [code ${apiCode}]` : ''),
					cookieExpired: isCookieExpiredCode(apiCode),
				});
			}
		}
	}

	/** 生成面板 HTML：伪装开关决定读取哪个页面模板（伪装=遮罩聚焦显示；不伪装=直接显示画面） */
	async renderPane(entry) {
		const disguiseEnabled = readConfig('disguiseEnabled', true);
		const safeEntry = {
			bvid: entry.bvid,
			title: entry.title,
			uploader: entry.uploader,
			durationText: entry.durationText,
			playCountText: formatCount(entry.playCount),
			danmakuCountText: formatCount(entry.danmakuCount),
			summary: entry.summary,
			cover: entry.cover,
		};
		const template = loadWebviewTemplate(this.context, disguiseEnabled ? 'pane-disguise.html' : 'pane-open.html');
		this.pane.webview.html = applyTemplate(template, {
			__AUTO_START__: readConfig('autoStartPlayback', true) ? 'autoplay' : '',
			__VOLUME__: JSON.stringify(readConfig('initialVolume', 0.5)),
			__PANE_WIDTH__: String(readConfig('playerPaneWidth', 400)),
			__ENTRY__: JSON.stringify(safeEntry),
			__DISGUISE_HTML__: disguiseEnabled ? buildDisguiseHtml(readConfig('disguiseFilePath', '')) : '',
		});
	}

	/** 伪装开关/伪装文件变更时，刷新已打开的面板 */
	async refreshDisplay() {
		if (this.pane && this.currentEntry) {
			await this.renderPane(this.currentEntry);
		}
	}
}

// ---------- 抖音：编辑区伪装播放面板（对齐 B站伪装面板：伪装成本地代码文件，遮罩聚焦/悬停淡出、失焦恢复） ----------
class DouyinHoverPane {
	constructor(context, mediaProxy) {
		this.context = context;
		this.mediaProxy = mediaProxy;
		this.pane = null;
		this.currentEntry = null;
	}

	/** 面板标题复用 B站伪装标题配置（伪装成本地代码文件名） */
	currentTitle() {
		return readConfig('playerPaneTitle', DEFAULT_PANE_TITLE) || DEFAULT_PANE_TITLE;
	}

	async show(entry) {
		// 树点击跨进程序列化后 entry 退化为普通对象（丢失 getter），此处统一重建（playUrls 为自有字段可保留）
		if (!(entry instanceof DouyinEntry)) {
			entry = new DouyinEntry(entry);
		}
		this.currentEntry = entry;
		const paneTitle = this.currentTitle();
		if (this.pane) {
			this.pane.title = paneTitle;
			this.pane.reveal(vscode.ViewColumn.One);
			await this.renderPane(entry);
			return;
		}
		this.pane = vscode.window.createWebviewPanel('biliHoverDouyinPane', paneTitle, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [],
		});
		this.pane.webview.onDidReceiveMessage(
			(message) => this.handlePaneMessage(message),
			undefined,
			this.context.subscriptions
		);
		this.pane.onDidDispose(
			() => {
				this.pane = null;
				this.currentEntry = null;
			},
			undefined,
			this.context.subscriptions
		);
		await this.renderPane(entry);
	}

	async handlePaneMessage(message) {
		if (!message || typeof message.command !== 'string') {
			return;
		}
		switch (message.command) {
			case 'dypane:requestStream':
				await this.deliverStream(message.awemeId, message.retryIndex || 0);
				break;
			case 'dypane:downloadVideo':
				await this.downloadVideo(message.awemeId, message.retryIndex || 0);
				break;
			case 'dypane:openOnSite':
				if (this.currentEntry && this.currentEntry.pageUrl) {
					await vscode.env.openExternal(vscode.Uri.parse(this.currentEntry.pageUrl));
				}
				break;
			case 'pane:persistWidth': {
				// 与 B站伪装面板共用宽度配置
				const width = Number(message.width);
				if (Number.isFinite(width) && width >= 200 && width <= 1200) {
					await updateGlobalConfig('playerPaneWidth', Math.round(width));
				}
				break;
			}
			default:
				break;
		}
	}

	/** 取可内播的 mp4 直链（剔除 m3u8），index 为备选线路序号 */
	pickDirectUrl(entry, index) {
		const directUrls = (entry.playUrls || []).filter((url) => !/\.m3u8/i.test(url));
		const i = Math.max(0, Number(index) || 0);
		return { directUrls, url: directUrls[i] || '', index: i };
	}

	/** 响应面板取流：mp4 直链经本地媒体代理包装（m3u8 不可内播，回退站外打开）；retryIndex 切换备选直链 */
	async deliverStream(requestAwemeId, retryIndex) {
		const entry = this.currentEntry;
		if (!entry || !this.pane) {
			return;
		}
		if (requestAwemeId && entry.awemeId && requestAwemeId !== entry.awemeId) {
			return; // 面板已切换视频，丢弃过期请求
		}
		try {
			await this.mediaProxy.ready();
			const { directUrls, url: directUrl, index } = this.pickDirectUrl(entry, retryIndex);
			if (!directUrl || !this.mediaProxy.port) {
				await this.pane.webview.postMessage({
					command: 'dypane:streamError',
					awemeId: entry.awemeId,
					retryIndex: index,
					pageUrl: entry.pageUrl,
					message: '该视频暂无可直接播放的流，请在浏览器打开',
				});
				return;
			}
			await this.pane.webview.postMessage({
				command: 'dypane:streamReady',
				awemeId: entry.awemeId,
				url: this.mediaProxy.localUrl(directUrl),
				retryIndex: index,
				hasAlternative: index < directUrls.length - 1,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error('[bili-hover-viewer] 抖音伪装面板取流失败:', errMsg);
			vscode.window.showErrorMessage(`抖音视频加载失败：${errMsg}`);
			if (this.pane) {
				await this.pane.webview.postMessage({
					command: 'dypane:streamError',
					awemeId: entry.awemeId,
					pageUrl: entry.pageUrl,
					message: errMsg,
				});
			}
		}
	}

	/** 下载入口：弹保存对话框选择路径后流式落盘（经本地代理，复用其重定向/Cookie/UA 处理） */
	async downloadVideo(requestAwemeId, retryIndex) {
		const entry = this.currentEntry;
		if (!entry || !this.pane) {
			return;
		}
		if (requestAwemeId && entry.awemeId && requestAwemeId !== entry.awemeId) {
			return;
		}
		const { directUrls, index: firstIndex } = this.pickDirectUrl(entry, retryIndex);
		if (directUrls.length === 0) {
			await this.postDownloadState(entry.awemeId, {
				state: 'error',
				message: '该视频仅有 HLS(m3u8) 流，暂不支持下载，请在浏览器打开',
			});
			vscode.window.showWarningMessage('该视频暂无可下载的 mp4 直链（仅 m3u8）');
			return;
		}
		const defaultName = `${sanitizeFileName(entry.title) || ('douyin_' + (entry.awemeId || 'video'))}.mp4`;
		const target = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', defaultName)),
			filters: { 视频: ['mp4'] },
			saveLabel: '下载抖音视频',
			title: '选择视频保存位置',
		});
		if (!target) {
			await this.postDownloadState(entry.awemeId, { state: 'idle' });
			return; // 用户取消
		}
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: '正在下载抖音视频', cancellable: false },
			(progress) => this.downloadFromIndex(entry, directUrls, firstIndex, target.fsPath, progress)
		);
	}

	/** 按直链序号下载到本地文件：失败自动切下一条备选直链 */
	async downloadFromIndex(entry, directUrls, index, filePath, progress) {
		if (index >= directUrls.length) {
			await this.postDownloadState(entry.awemeId, { state: 'error', message: '所有下载线路均失败，请稍后重试或去浏览器观看' });
			vscode.window.showErrorMessage('抖音视频下载失败：所有线路均不可用');
			return;
		}
		await this.mediaProxy.ready();
		const localUrl = this.mediaProxy.localUrl(directUrls[index]);
		await this.postDownloadState(entry.awemeId, { state: 'progress', percent: 0, received: 0, total: 0, retryIndex: index });
		try {
			await new Promise((resolve, reject) => {
				const req = http.get(localUrl, (res) => {
					if (res.statusCode !== 200 && res.statusCode !== 206) {
						res.resume();
						reject(new Error(`代理返回 HTTP ${res.statusCode}`));
						return;
					}
					const total = Number(res.headers['content-length']) || 0;
					let received = 0;
					let lastReport = 0;
					const writer = fs.createWriteStream(filePath);
					res.on('data', (chunk) => {
						received += chunk.length;
						// 每 500ms 或增量超过 512KB 上报一次进度，避免消息风暴
						const now = Date.now();
						if (now - lastReport > 500) {
							lastReport = now;
							const percent = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
							this.postDownloadState(entry.awemeId, { state: 'progress', percent, received, total, retryIndex: index });
							if (total) {
								progress.report({ increment: percent - (this._lastPercent || 0), message: `${percent}%` });
								this._lastPercent = percent;
							}
						}
					});
					res.pipe(writer);
					writer.on('finish', resolve);
					writer.on('error', reject);
					res.on('error', reject);
				});
				req.on('error', reject);
			});
			this._lastPercent = 0;
			await this.postDownloadState(entry.awemeId, { state: 'done', filePath });
			const action = await vscode.window.showInformationMessage(`抖音视频已保存：${filePath}`, '打开所在文件夹');
			if (action === '打开所在文件夹') {
				vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
			}
		} catch (error) {
			this._lastPercent = 0;
			console.error('[bili-hover-viewer] 抖音视频下载失败(线路' + index + '):', error.message);
			// 删除残缺文件，再尝试下一条直链
			try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { /* 忽略清理失败 */ }
			if (index + 1 < directUrls.length) {
				await this.postDownloadState(entry.awemeId, { state: 'progress', percent: 0, retryIndex: index + 1, message: '线路不可用，正在切换备用线路…' });
				await this.downloadFromIndex(entry, directUrls, index + 1, filePath, progress);
			} else {
				await this.postDownloadState(entry.awemeId, { state: 'error', message: error.message || '下载失败' });
				vscode.window.showErrorMessage(`抖音视频下载失败：${error.message}`);
			}
		}
	}

	/** 统一下载状态推送 */
	async postDownloadState(awemeId, payload) {
		if (this.pane) {
			await this.pane.webview.postMessage(Object.assign({ command: 'dypane:downloadState', awemeId }, payload));
		}
	}

	/** 生成面板 HTML：固定使用抖音伪装页面（遮罩 + 编辑器风格伪装内容） */
	async renderPane(entry) {
		const safeEntry = {
			awemeId: entry.awemeId,
			title: entry.title,
			author: entry.author,
			cover: entry.cover,
			durationText: entry.durationText,
			diggText: formatCount(entry.digg),
			commentText: formatCount(entry.comment),
			shareText: formatCount(entry.share),
			pageUrl: entry.pageUrl,
			// 可内播直链数量：供前端在播放失败时逐一切换备选地址
			playUrlCount: (entry.playUrls || []).filter((url) => !/\.m3u8/i.test(url)).length,
		};
		const template = loadWebviewTemplate(this.context, 'pane-douyin-disguise.html');
		this.pane.webview.html = applyTemplate(template, {
			// 抖音伪装面板使用抖音模块自己的自动播放/音量配置
			__AUTO_START__: readConfig('douyinAutoPlay', true) ? 'autoplay' : '',
			__VOLUME__: JSON.stringify(readConfig('douyinVolume', 0.5)),
			__PANE_WIDTH__: String(readConfig('playerPaneWidth', 400)),
			__ENTRY__: JSON.stringify(safeEntry),
			__DISGUISE_HTML__: buildDisguiseHtml(readConfig('disguiseFilePath', '')),
		});
	}

	/** 伪装文件变更时，刷新已打开的面板 */
	async refreshDisplay() {
		if (this.pane && this.currentEntry) {
			await this.renderPane(this.currentEntry);
		}
	}
}

// ---------- 激活入口 ----------
function activate(context) {
	// 抖音网络环境诊断：扩展宿主可能被 vscode-proxy-agent patch（配合系统代理导致抖音请求空 body），输出关键证据便于定位
	try {
		// http(s).request 在原生 Node 下也是 JS 函数，native code 判据无效；用 globalAgent 类名与函数源码识别
		const requestSource = Function.prototype.toString.call(https.request).replace(/\s+/g, ' ').slice(0, 120);
		const diag = {
			globalAgent: https.globalAgent && https.globalAgent.constructor ? https.globalAgent.constructor.name : 'none',
			agentProto: (Object.getPrototypeOf(https.globalAgent || {}).constructor || {}).name || 'none',
			envProxy: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || '',
			nodeOptions: process.env.NODE_OPTIONS || '',
			vscodeProxy: vscode.workspace.getConfiguration('http').get('proxy', ''),
			requestSource,
		};
		console.log('[dy-diag] 宿主网络环境:', JSON.stringify(diag));
	} catch (error) {
		console.log('[dy-diag] 诊断失败:', error.message);
	}

	const feedClient = new VideoFeedClient();
	const listIconUri = vscode.Uri.joinPath(context.extensionUri, 'resources', 'js-icon.svg');
	const sidebarProvider = new VideoSidebarProvider(feedClient, listIconUri);
	const videoPane = new HoverVideoPane(context, feedClient);
	const feedView = new DisguiseFeedView(sidebarProvider, feedClient, context);
	// 侧边栏数据变化时同步到视频流页面
	sidebarProvider.onEntriesChanged = () => feedView.pushEntries();

	// 抖音：客户端 + 本地媒体代理 + 竖滑视图（代理生命周期挂到 subscriptions）
	const douyinClient = new DouyinClient();
	// 启动后立即自检 worker 纯 Node 模式是否生效（结果写入日志与 client.workerPing，供错误诊断）
	douyinClient.pingWorker();
	const douyinProxy = new DouyinMediaProxy();
	const douyinView = new DouyinFeedView(douyinClient, douyinProxy, context);
	// 抖音伪装模式：文件样式列表 + 编辑区伪装播放面板（与 B站共用同一伪装开关）
	const douyinListProvider = new DouyinListProvider(douyinClient, listIconUri);
	const douyinPane = new DouyinHoverPane(context, douyinProxy);
	douyinProxy.start().catch((error) => {
		vscode.window.showWarningMessage('抖音媒体代理启动失败，视频可能无法播放：' + (error instanceof Error ? error.message : error));
	});
	context.subscriptions.push({ dispose: () => douyinProxy.stop() });
	context.subscriptions.push({ dispose: () => dyWorker.stop() });

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('biliHoverVideoList', sidebarProvider),
		vscode.window.registerTreeDataProvider('biliHoverDouyinList', douyinListProvider),
		vscode.window.registerWebviewViewProvider('biliHoverFeedView', feedView, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.window.registerWebviewViewProvider('biliHoverDouyinView', douyinView, { webviewOptions: { retainContextWhenHidden: true } }),

		vscode.commands.registerCommand('biliHover.refreshVideoList', () => sidebarProvider.reloadFeed()),

		vscode.commands.registerCommand('biliHover.searchVideos', async () => {
			const keyword = await vscode.window.showInputBox({
				prompt: '请输入要搜索的视频关键词',
				placeHolder: '例如：编程教程',
				ignoreFocusOut: true,
			});
			if (keyword && keyword.trim()) {
				await sidebarProvider.searchByKeyword(keyword.trim());
			}
		}),

		vscode.commands.registerCommand('biliHover.configureCookie', () => inputAndSaveCookie()),

		// 抖音命令：刷新（伪装开 → 刷新列表；伪装关 → 通知竖滑页）/ 设置 Cookie / 上下切换 / 列表点击播放
		vscode.commands.registerCommand('biliHover.douyinRefresh', () => {
			if (readConfig('disguiseEnabled', true)) {
				return douyinListProvider.reloadFeed();
			}
			return douyinView.reload();
		}),
		vscode.commands.registerCommand('biliHover.douyinSetCookie', () => inputAndSaveDouyinCookie()),
		vscode.commands.registerCommand('biliHover.douyinPrevVideo', () => douyinView.navigate('prev')),
		vscode.commands.registerCommand('biliHover.douyinNextVideo', () => douyinView.navigate('next')),
		vscode.commands.registerCommand('biliHover.douyinPlaySelected', (entry) => douyinPane.show(entry)),

		// 抖音伪装列表搜索：输入关键词 → 树形结果（含返回推荐/加载更多/风控重试占位项）
		vscode.commands.registerCommand('biliHover.douyinSearch', async () => {
			const keyword = await vscode.window.showInputBox({
				prompt: '请输入要搜索的抖音关键词',
				placeHolder: '例如：猫咪、编程教程',
				value: douyinListProvider.searchKeyword || '',
				ignoreFocusOut: true,
			});
			if (keyword !== undefined && keyword.trim()) {
				await douyinListProvider.searchByKeyword(keyword.trim());
			}
		}),
		vscode.commands.registerCommand('biliHover.douyinExitSearch', () => douyinListProvider.exitSearch()),
		vscode.commands.registerCommand('biliHover.douyinSearchRetry', () => douyinListProvider.retrySearch()),
		vscode.commands.registerCommand('biliHover.douyinSearchMore', () => douyinListProvider.loadMoreSearch()),

		// 切换伪装开关：B站与抖音侧边栏视图显隐均由 when 子句自动切换，已打开面板由配置监听重渲染
		vscode.commands.registerCommand('biliHover.toggleDisguise', async () => {
			const next = !readConfig('disguiseEnabled', true);
			await updateGlobalConfig('disguiseEnabled', next);
			vscode.window.showInformationMessage(
				next
					? '已开启伪装：B站/抖音侧边栏均为视频列表，点击后在编辑区打开伪装面板（聚焦显示画面、失焦隐藏）'
					: '已关闭伪装：侧边栏为视频流页面，点击视频原位播放'
			);
		}),

		vscode.commands.registerCommand('biliHover.customizeSidebarTitle', async () => {
			const current = readConfig('sidebarViewTitle', DEFAULT_SIDEBAR_TITLE);
			const input = await vscode.window.showInputBox({
				prompt: '请输入侧边栏显示标题（写入插件清单，重启编辑器后生效）',
				value: current,
				ignoreFocusOut: true,
			});
			if (input !== undefined && input.trim() && input.trim() !== current) {
				await updateGlobalConfig('sidebarViewTitle', input.trim());
				syncSidebarTitleFromConfig(context);
			}
		}),

		vscode.commands.registerCommand('biliHover.playSelectedVideo', (entry) => videoPane.show(entry)),

		vscode.commands.registerCommand('biliHover.searchPrevPage', () => sidebarProvider.gotoPrevPage()),
		vscode.commands.registerCommand('biliHover.searchNextPage', () => sidebarProvider.gotoNextPage()),

		vscode.commands.registerCommand('biliHover.playRandomVideo', async () => {
			await sidebarProvider.reloadFeed();
			const entry = sidebarProvider.getRandomEntry();
			if (!entry || !entry.bvid) {
				vscode.window.showWarningMessage(entry ? '当前列表为占位数据，暂无可播放视频' : '暂无可用视频');
				return;
			}
			// 按伪装开关分流渲染：伪装 → 编辑区面板（伪装页面）；不伪装 → 侧边栏视频流内原位播放
			if (readConfig('disguiseEnabled', true)) {
				await videoPane.show(entry);
			} else {
				await feedView.playRandomInWebview(entry.bvid);
			}
		}),

		// 配置变更：Cookie → 刷新列表；侧边栏标题 → 同步写入插件清单；伪装开关/伪装文件 → 刷新面板；面板标题 → 立即改标题
		// （伪装开关同时用于 when 子句，侧边栏视图显隐由编辑器自动切换）
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('biliHover.userCookie')) {
				sidebarProvider.reloadFeed();
			}
			if (event.affectsConfiguration('biliHover.douyinCookie')) {
				douyinView.handleCookieChanged();
				// 伪装列表同步重置（含退出搜索态）并重新加载推荐
				douyinListProvider.entries = [];
				douyinListProvider.state = '';
				douyinListProvider.errorMsg = '';
				douyinListProvider.searchKeyword = '';
				douyinListProvider.searchOffset = 0;
				douyinListProvider.hasMoreSearch = false;
				douyinListProvider.reloadFeed();
			}
			if (event.affectsConfiguration('biliHover.sidebarViewTitle')) {
				syncSidebarTitleFromConfig(context);
			}
			if (
				event.affectsConfiguration('biliHover.disguiseEnabled') ||
				event.affectsConfiguration('biliHover.disguiseFilePath')
			) {
				videoPane.refreshDisplay();
				douyinPane.refreshDisplay();
			}
			if (event.affectsConfiguration('biliHover.playerPaneTitle')) {
				if (videoPane.pane) {
					videoPane.pane.title = videoPane.currentTitle();
				}
				if (douyinPane.pane) {
					douyinPane.pane.title = douyinPane.currentTitle();
				}
			}
		})
	);

	console.log('[bili-hover-viewer] 已激活');
	// 激活后自动加载推荐流，避免侧边栏初始为空
	setTimeout(() => {
		sidebarProvider.reloadFeed();
	}, 300);
}

function deactivate() {}

module.exports = { activate, deactivate };
