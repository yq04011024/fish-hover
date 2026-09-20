/* ============================================================
 * bilibili-ui.js — B站表现层：
 *   VideoSidebarProvider 悬停展示模式树形列表
 *   DisguiseFeedView    常规展示模式仿B站视频流 webview
 *   HoverVideoPane      编辑区播放面板
 *   Cookie 输入/引导弹窗
 * ============================================================ */
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const {
	FEED_DISPLAY_LIMIT,
	DEFAULT_PANE_TITLE,
	DEFAULT_OPEN_PANE_TITLE,
	readConfig,
	updateGlobalConfig,
	isCookieExpiredCode,
	formatCount,
	loadWebviewTemplate,
	applyTemplate,
	buildDisguiseHtml,
} = require('./shared');
const {
	VideoEntry,
	serializeEntry,
	serializeLiveRoom,
	LOGIN_POLL_INTERVAL_MS,
	QR_STATE_SUCCESS,
	QR_STATE_EXPIRED,
	QR_STATE_CONFIRMED,
	QR_STATE_NOT_SCANNED,
	WATCHLATER_PAGE_SIZE,
} = require('./bilibili-core');

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

module.exports = {
	VideoSidebarProvider,
	DisguiseFeedView,
	HoverVideoPane,
	inputAndSaveCookie,
};
