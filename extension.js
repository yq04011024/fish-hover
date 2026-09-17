const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

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

// Cookie 失效类错误码
const COOKIE_EXPIRED_CODES = new Set([-101, -412]);

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
	constructor({ bvid, avid, cid, title, uploader, uploaderFace, cover, durationSec, summary, playCount, danmakuCount }) {
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
}

/** VideoEntry → 可序列化普通对象（传给 webview 用） */
function serializeEntry(entry) {
	return {
		bvid: entry.bvid,
		title: entry.title,
		uploader: entry.uploader,
		cover: entry.cover,
		durationText: entry.durationText,
		playCountText: formatCount(entry.playCount),
		danmakuCountText: formatCount(entry.danmakuCount),
		summary: entry.summary,
		pageUrl: entry.pageUrl,
	};
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

	/** 带超时的 JSON GET */
	async fetchJson(url) {
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
			return body;
		} finally {
			clearTimeout(timer);
		}
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
					return { entries: body.data.item.map(videoEntryFromFeedItem).slice(0, FEED_DISPLAY_LIMIT), degradedByCookie };
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
				return { entries: body.data.items.map(videoEntryFromFeedItem).slice(0, FEED_DISPLAY_LIMIT), degradedByCookie };
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
		const results = (body.data && body.data.result) || [];
		const numResults = (body.data && body.data.numResults) || 0;
		return { entries: results.map(videoEntryFromSearchItem), numResults };
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

// ---------- 不伪装模式：侧边栏视频流（卡片列表 + 内嵌直接播放，原创实现） ----------
class DisguiseFeedView {
	constructor(sidebarProvider, feedClient, context) {
		this.sidebarProvider = sidebarProvider;
		this.feedClient = feedClient;
		this.context = context;
		this.view = null;
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

	/** 页面 HTML：读取不伪装模式的视频流页面模板并注入配置 */
	buildHtml() {
		const template = loadWebviewTemplate(this.context, 'feed.html');
		return applyTemplate(template, {
			__AUTO_START__: readConfig('autoStartPlayback', true) ? 'autoplay' : '',
			__VOLUME__: JSON.stringify(readConfig('initialVolume', 0.5)),
		});
	}

	findEntry(bvid) {
		return this.sidebarProvider.videoEntries.find((item) => item.bvid && item.bvid === bvid) || null;
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
			case 'feed:play':
				await this.playEntry(message.bvid);
				break;
			case 'feed:openOnSite': {
				const entry = this.findEntry(message.bvid);
				if (entry && entry.pageUrl) {
					await vscode.env.openExternal(vscode.Uri.parse(entry.pageUrl));
				}
				break;
			}
			default:
				break;
		}
	}

	/** 解析播放流并推送给页面 */
	async playEntry(requestBvid) {
		const entry = this.findEntry(requestBvid);
		if (!entry) {
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
				message: errMsg + (apiCode ? ` [code ${apiCode}]` : ''),
				cookieExpired: isCookieExpiredCode(apiCode),
			});
		}
	}

	/** 不伪装模式随机播放：通知视频流页面在对应卡片内原位播放 */
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

// ---------- 激活入口 ----------
function activate(context) {
	const feedClient = new VideoFeedClient();
	const listIconUri = vscode.Uri.joinPath(context.extensionUri, 'resources', 'js-icon.svg');
	const sidebarProvider = new VideoSidebarProvider(feedClient, listIconUri);
	const videoPane = new HoverVideoPane(context, feedClient);
	const feedView = new DisguiseFeedView(sidebarProvider, feedClient, context);
	// 侧边栏数据变化时同步到视频流页面
	sidebarProvider.onEntriesChanged = () => feedView.pushEntries();

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('biliHoverVideoList', sidebarProvider),
		vscode.window.registerWebviewViewProvider('biliHoverFeedView', feedView, { webviewOptions: { retainContextWhenHidden: true } }),

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

		// 切换伪装开关：侧边栏视图显隐由 when 子句自动切换，已打开面板由配置监听按新开关选用页面模板重渲染
		vscode.commands.registerCommand('biliHover.toggleDisguise', async () => {
			const next = !readConfig('disguiseEnabled', true);
			await updateGlobalConfig('disguiseEnabled', next);
			vscode.window.showInformationMessage(
				next
					? '已开启伪装：侧边栏为视频列表，播放面板伪装为本地代码文件（聚焦显示画面、失焦隐藏）'
					: '已关闭伪装：侧边栏为视频流卡片列表，点击后视频在卡片位置原位播放'
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
			if (event.affectsConfiguration('biliHover.sidebarViewTitle')) {
				syncSidebarTitleFromConfig(context);
			}
			if (
				event.affectsConfiguration('biliHover.disguiseEnabled') ||
				event.affectsConfiguration('biliHover.disguiseFilePath')
			) {
				videoPane.refreshDisplay();
			}
			if (event.affectsConfiguration('biliHover.playerPaneTitle')) {
				if (videoPane.pane) {
					videoPane.pane.title = videoPane.currentTitle();
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
