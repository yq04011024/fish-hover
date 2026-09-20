/* ============================================================
 * bili-hover-viewer 扩展入口
 * 侧边栏推荐视频（Cookie 个性化 / 随机）+ 常规/悬停双展示模式
 *
 * 本文件仅负责激活时的对象装配、命令注册与配置监听；
 * 业务实现按平台拆分在 lib/ 下：
 *   lib/shared.js       通用常量与工具函数
 *   lib/bilibili-core.js B站数据模型与 API 客户端
 *   lib/bilibili-ui.js   B站侧边栏列表 / 视频流页面 / 播放面板
 *   lib/douyin-core.js   抖音模型 / 常驻请求子进程 / API 客户端 / 媒体代理
 *   lib/douyin-ui.js     抖音列表 / 竖滑页面 / 播放面板
 * ============================================================ */
'use strict';

const vscode = require('vscode');
const https = require('https');

const {
	DEFAULT_SIDEBAR_TITLE,
	readConfig,
	updateGlobalConfig,
	syncSidebarTitleFromConfig,
} = require('./lib/shared');
const { VideoFeedClient } = require('./lib/bilibili-core');
const {
	VideoSidebarProvider,
	DisguiseFeedView,
	HoverVideoPane,
	inputAndSaveCookie,
} = require('./lib/bilibili-ui');
const { DouyinClient, DouyinMediaProxy, dyWorker } = require('./lib/douyin-core');
const {
	DouyinListProvider,
	DouyinFeedView,
	DouyinHoverPane,
	inputAndSaveDouyinCookie,
} = require('./lib/douyin-ui');

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
	// 抖音悬停展示：文件样式列表 + 编辑区播放面板（与 B站共用同一展示模式开关）
	const douyinListProvider = new DouyinListProvider(douyinClient, listIconUri);
	const douyinPane = new DouyinHoverPane(context, douyinProxy);
	douyinProxy.start().catch((error) => {
		vscode.window.showWarningMessage('抖音媒体代理启动失败，视频可能无法播放：' + (error instanceof Error ? error.message : error));
	});
	context.subscriptions.push({ dispose: () => douyinProxy.stop() });
	context.subscriptions.push({ dispose: () => dyWorker.stop() });

	// 展示模式切换：常规展示（disguiseEnabled=false）/ 悬停展示（disguiseEnabled=true）
	// 标题栏按钮图标随当前状态动态切换：常规=无斜线 eye，悬停=带斜线 eye-closed（when 子句按 config 互斥显隐）
	const setDisplayMode = async (hoverMode) => {
		if (readConfig('disguiseEnabled', true) === hoverMode) { return; }
		await updateGlobalConfig('disguiseEnabled', hoverMode);
		// B站与抖音侧边栏视图显隐均由 when 子句自动切换，已打开面板由配置监听重渲染
		vscode.window.showInformationMessage(
			hoverMode
				? '已切换为悬停展示模式：B站/抖音侧边栏为视频列表，点击后在编辑区打开播放面板（鼠标悬停显示画面、移开恢复代码内容）'
				: '已切换为常规展示模式：侧边栏为视频流页面，点击视频原位播放'
		);
	};

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

		// 抖音命令：刷新（悬停模式 → 刷新列表；常规模式 → 通知竖滑页）/ 设置 Cookie / 上下切换 / 列表点击播放
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

		// 抖音悬停列表搜索：输入关键词 → 树形结果（含返回推荐/加载更多/风控重试占位项）
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

		// 常规展示 / 悬停展示切换命令（标题栏按 config 状态互斥显示，图标随之动态变化）
		vscode.commands.registerCommand('biliHover.enterHoverMode', () => setDisplayMode(true)),
		vscode.commands.registerCommand('biliHover.enterNormalMode', () => setDisplayMode(false)),
		// 兼容旧命令 id（历史版本快捷键/外部调用）：在两种模式间来回切换
		vscode.commands.registerCommand('biliHover.toggleDisguise', () => setDisplayMode(!readConfig('disguiseEnabled', true))),

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
			// 按展示模式分流渲染：悬停 → 编辑区面板；常规 → 侧边栏视频流内原位播放
			if (readConfig('disguiseEnabled', true)) {
				await videoPane.show(entry);
			} else {
				await feedView.playRandomInWebview(entry.bvid);
			}
		}),

		// 配置变更：Cookie → 刷新列表；侧边栏标题 → 同步写入插件清单；模式开关/遮罩文件 → 刷新面板；面板标题 → 立即改标题
		// （模式开关同时用于 when 子句，侧边栏视图显隐由编辑器自动切换）
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('biliHover.userCookie')) {
				sidebarProvider.reloadFeed();
			}
			if (event.affectsConfiguration('biliHover.douyinCookie')) {
				douyinView.handleCookieChanged();
				// 悬停列表同步重置（含退出搜索态）并重新加载推荐
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
