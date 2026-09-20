/**
 * 抖音请求常驻子进程 worker
 *
 * 为什么需要它：
 *   VS Code/Trae 扩展宿主的网络栈会被 vscode-proxy-agent 等机制影响（系统代理/Agent patch），
 *   在宿主进程内请求抖音接口会被风控拦截返回 200 空 body；而独立 Node 进程用完全相同的
 *   URL/请求头/签名可以正常拿到数据。故抖音 API 请求统一放到本 worker（由宿主以
 *   ELECTRON_RUN_AS_NODE=1 的纯 Node 模式启动）中执行，网络环境与宿主完全隔离。
 *
 * 常驻模式（性能）：
 *   进程启动后持续待命，宿主与本进程之间按「行分隔 JSON」通信，避免每次请求都冷启动
 *   Electron 纯 Node 进程（冷启动约数百 ms，是抖音模块加载慢的主因）。
 *
 * 通信协议（每行一个 JSON，Cookie 只走 stdin，不进命令行参数）：
 *   stdin  : { id, url, headers, timeout? }           发请求
 *            { id, ping: true }                       环境自检（不发网络请求）
 *            { id, shutdown: true }                   优雅退出
 *   stdout  : { id, ok: true, status, text, resInfo, reqEcho, diag }
 *            { id, ok: false, error, ... }
 */
'use strict';
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');

/** 简易输入指纹：不回传 Cookie 明文，只给长度与首尾字符/hash，供宿主核对 stdin 是否截断 */
function fingerprintCookie(cookie) {
	const value = String(cookie || '');
	if (!value) {
		return { len: 0, head: '', tail: '', sha: '' };
	}
	return {
		len: value.length,
		head: value.slice(0, 12),
		tail: value.slice(-12),
		sha: crypto.createHash('sha1').update(value).digest('hex').slice(0, 12),
	};
}

/** worker 自身网络环境诊断：用于确认子进程是否仍被宿主注入的引导脚本污染 */
function collectDiag() {
	// 注意：http(s).request 在任何 Node 下都是 JS 包装函数（非 [native code]），
	// 不能用 native code 判据；改为输出函数源码开头与 globalAgent 类名，与纯净 Node 对照即可识别 patch
	const requestSource = Function.prototype.toString.call(https.request).replace(/\s+/g, ' ').slice(0, 100);
	const agentProto = Object.getPrototypeOf(https.globalAgent || {});
	return {
		node: process.version,
		execPath: process.execPath,
		runAsNode: process.env.ELECTRON_RUN_AS_NODE || '',
		nodeOptions: process.env.NODE_OPTIONS || '',
		inspector: process.env.VSCODE_INSPECTOR_OPTIONS ? '(set)' : '',
		// 回传所有代理相关环境变量名与值（排查宿主注入代理）
		proxyEnv: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy', 'GLOBAL_AGENT_HTTP_PROXY']
			.filter((key) => process.env[key])
			.map((key) => `${key}=${process.env[key]}`)
			.join('; '),
		globalAgentClass: https.globalAgent && https.globalAgent.constructor ? https.globalAgent.constructor.name : 'none',
		agentProtoIsHttpsAgent: agentProto && agentProto.constructor ? agentProto.constructor.name : 'none',
		requestSource,
	};
}

function reply(line) {
	try {
		process.stdout.write(JSON.stringify(line) + '\n');
	} catch (error) {
		// 输出失败时给出兜底错误（JSON.stringify 对字符串总是可行，此处仅防御极端情况）
		process.stdout.write(JSON.stringify({ id: line && line.id, ok: false, error: 'worker 输出失败: ' + error.message }) + '\n');
	}
}

/** 处理一行请求 */
async function handleLine(payload) {
	const id = payload.id;
	// ping：不发起网络请求，仅回报子进程环境
	if (payload.ping) {
		reply({ id, ok: true, status: 0, text: 'pong', diag: collectDiag() });
		return;
	}
	// 优雅退出（先回包再退出，便于宿主确认）
	if (payload.shutdown) {
		reply({ id, ok: true, text: 'bye' });
		setTimeout(() => process.exit(0), 10);
		return;
	}
	const reqEcho = {
		urlLen: String(payload.url || '').length,
		urlHead: String(payload.url || '').slice(0, 80),
		headerKeys: Object.keys(payload.headers || {}),
		cookie: fingerprintCookie(payload.headers && payload.headers.Cookie),
	};
	try {
		const { text, encoding, resInfo } = await request(payload.url, payload.headers || {}, payload.timeout || 15000, 3);
		reply({ id, ok: true, status: 200, text, encoding, resInfo, reqEcho, diag: collectDiag() });
	} catch (error) {
		reply({
			id,
			ok: false,
			error: error && error.message ? error.message : String(error),
			resInfo: error && error.resInfo ? error.resInfo : undefined,
			reqEcho,
			diag: collectDiag(),
		});
	}
}

// 按行读取宿主请求（每行一个 JSON）
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
	const trimmed = String(line || '').trim();
	if (!trimmed) {
		return;
	}
	let payload;
	try {
		payload = JSON.parse(trimmed);
	} catch (error) {
		reply({ id: null, ok: false, error: 'worker 输入解析失败: ' + error.message, diag: collectDiag() });
		return;
	}
	handleLine(payload);
});
rl.on('close', () => process.exit(0));

/** GET 请求：手动跟随重定向 + 按 content-encoding 解压（与 axios 行为一致）；附带响应头与 TCP 对端信息 */
function request(url, headers, timeout, redirectsLeft) {
	return new Promise((resolve, reject) => {
		const mod = url.startsWith('https:') ? https : http;
		const req = mod.get(url, { headers }, (res) => {
			const status = res.statusCode || 0;
			// TCP 层信息：remoteAddress 若是本地代理地址（127.x/内网常见代理端口）说明流量被代理接管
			const socketInfo = res.socket
				? { remoteAddress: res.socket.remoteAddress, remotePort: res.socket.remotePort, localAddress: res.socket.localAddress, localPort: res.socket.localPort }
				: null;
			const location = res.headers.location;
			if (location && redirectsLeft > 0 && [301, 302, 303, 307, 308].includes(status)) {
				res.resume();
				resolve(request(new URL(location, url).toString(), headers, timeout, redirectsLeft - 1));
				return;
			}
			const resInfo = {
				statusCode: status,
				headers: {
					'content-length': res.headers['content-length'],
					'content-type': res.headers['content-type'],
					'content-encoding': res.headers['content-encoding'],
					server: res.headers['server'],
					via: res.headers['via'],
					'x-cache': res.headers['x-cache'],
					location,
				},
				socket: socketInfo,
			};
			if (status !== 200) {
				res.resume();
				reject(Object.assign(new Error('HTTP ' + status), { resInfo }));
				return;
			}
			let stream = res;
			const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
			if (encoding.includes('br')) {
				stream = res.pipe(zlib.createBrotliDecompress());
			} else if (encoding.includes('gzip')) {
				stream = res.pipe(zlib.createGunzip());
			} else if (encoding.includes('deflate')) {
				stream = res.pipe(zlib.createInflate());
			}
			const chunks = [];
			stream.on('data', (chunk) => chunks.push(chunk));
			stream.on('error', reject);
			stream.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), encoding: encoding || 'none', resInfo }));
		});
		req.on('error', reject);
		req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
	});
}
