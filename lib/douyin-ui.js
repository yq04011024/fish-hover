/* ============================================================
 * douyin-ui.js — 抖音表现层：
 *   DouyinListProvider 悬停展示模式树形列表（推荐 + 搜索状态机）
 *   DouyinFeedView     常规展示模式竖向沉浸式 webview
 *   DouyinHoverPane    编辑区播放面板（含本地保存）
 *   Cookie 输入弹窗
 * ============================================================ */
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const {
	DEFAULT_PANE_TITLE,
	readConfig,
	updateGlobalConfig,
	formatCount,
	sanitizeFileName,
	loadWebviewTemplate,
	applyTemplate,
	buildDisguiseHtml,
} = require('./shared');
const { DouyinEntry, DY_MAX_LIST_SIZE } = require('./douyin-core');

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

module.exports = {
	DouyinListProvider,
	DouyinFeedView,
	DouyinHoverPane,
	inputAndSaveDouyinCookie,
};
