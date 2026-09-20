/* ============================================================
 * shared.js — 通用常量与工具函数（B站/抖音模块共用）
 * 从 extension.js 拆分而来，不含任何业务流程，仅提供配置读写、
 * 格式化、模板处理、Cookie 工具等纯函数。
 * ============================================================ */
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const FEED_DISPLAY_LIMIT = 8; // 侧边栏推荐列表最多展示条数
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_SIDEBAR_TITLE = '聚焦视界'; // 与 package.json 默认值保持一致
const DEFAULT_PANE_TITLE = 'jsProject00111.js'; // 伪装模式下播放面板标题（伪装成本地代码文件）
const DEFAULT_OPEN_PANE_TITLE = 'B站视频'; // 不伪装模式的播放面板标题
const DISGUISE_MAX_LINES = 600; // 伪装文件最多渲染行数

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

module.exports = {
	// 常量
	FEED_DISPLAY_LIMIT,
	REQUEST_TIMEOUT_MS,
	DEFAULT_SIDEBAR_TITLE,
	DEFAULT_PANE_TITLE,
	DEFAULT_OPEN_PANE_TITLE,
	DISGUISE_MAX_LINES,
	COOKIE_EXPIRED_CODES,
	// 配置 / 格式化 / 工具
	readConfig,
	updateGlobalConfig,
	parseDurationToSeconds,
	formatDuration,
	formatCount,
	ensureHttps,
	stripHighlightTags,
	isCookieExpiredCode,
	extractCookiePairs,
	sanitizeFileName,
	escapeHtmlText,
	loadWebviewTemplate,
	applyTemplate,
	buildDisguiseHtml,
	syncSidebarTitleFromConfig,
};
