'use strict';

/* ============================================================
 * dy-signer.js —— 抖音 a_bogus 签名器（纯算法独立实现）
 *
 * 算法依据公开的逆向研究结论：
 *   a_bogus = customBase64(随机前缀(12B) + RC4(环境字节块)) + "="
 *   环境字节块由 SM3 双重哈希（查询串 / 后缀 / UA）、时间戳字节、
 *   固定应用参数（aid/pageId）与异或校验位按固定顺序拼装。
 * 本文件为独立实现，无外部依赖；仅覆盖本插件所需的最小场景：
 * 对 GET 请求查询串签名（追加 a_bogus 参数）。
 * ============================================================ */

// ---------- SM3 国密哈希（输出 32 字节） ----------
const SM3_IV = [
	0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
	0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

function rotl32(x, n) {
	n %= 32;
	return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** 常量 Tj：前 16 轮与后 48 轮两组 */
function sm3T(j) {
	return j < 16 ? 0x79cc4519 : 0x7a879d8a;
}

/** 布尔函数 FF / GG */
function sm3FF(j, a, b, c) {
	return j < 16 ? (a ^ b ^ c) >>> 0 : ((a & b) | (a & c) | (b & c)) >>> 0;
}
function sm3GG(j, a, b, c) {
	return j < 16 ? (a ^ b ^ c) >>> 0 : ((a & b) | (~a & c)) >>> 0;
}

/** 置换函数 P0 */
function sm3P0(x) {
	return (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0;
}

function sm3Pad(sizeBytes) {
	const bits = sizeBytes * 8;
	const tailLen = sizeBytes % 64; // 末尾不足 64 字节的剩余长度
	// 填充总长使 (tailLen + padLen) ≡ 0 (mod 64)：0x80 + k 个 0 + 8 字节长度
	const padLen = tailLen < 56 ? 64 - tailLen : 128 - tailLen;
	const pad = [0x80];
	for (let i = 0; i < padLen - 9; i++) {
		pad.push(0);
	}
	// 64 位大端长度（高位用两个 32 位段拼接）
	for (let i = 3; i >= 0; i--) {
		pad.push(Math.floor(bits / 2 ** 32 / 2 ** (i * 8)) & 0xff);
	}
	for (let i = 3; i >= 0; i--) {
		pad.push((bits >>> (i * 8)) & 0xff);
	}
	return pad;
}

/** 输入转字节：字符串按 UTF-8（与 encodeURIComponent 展开等价），数组原样 */
function toBytes(input) {
	if (Array.isArray(input)) {
		return input.slice();
	}
	const escaped = encodeURIComponent(String(input));
	const bytes = [];
	for (let i = 0; i < escaped.length; i++) {
		if (escaped[i] === '%') {
			bytes.push(parseInt(escaped.substr(i + 1, 2), 16));
			i += 2;
		} else {
			bytes.push(escaped.charCodeAt(i));
		}
	}
	return bytes;
}

function sm3(input) {
	const reg = SM3_IV.slice();
	const data = toBytes(input);
	const total = data.length;

	// 按 64 字节分块压缩（最后一轮补位后合并处理）
	const blocks = [];
	for (let off = 0; off < total - (total % 64); off += 64) {
		blocks.push(data.slice(off, off + 64));
	}
	let tail = data.slice(total - (total % 64));
	tail = tail.concat(sm3Pad(total));
	for (let off = 0; off < tail.length; off += 64) {
		blocks.push(tail.slice(off, off + 64));
	}

	for (const block of blocks) {
		// 消息扩展：W[0..67] 与 W'[0..63]
		const w = new Array(68);
		for (let i = 0; i < 16; i++) {
			w[i] = ((block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3]) >>> 0;
		}
		for (let i = 16; i < 68; i++) {
			let tmp = w[i - 16] ^ w[i - 9] ^ rotl32(w[i - 3], 15);
			tmp = tmp ^ rotl32(tmp, 15) ^ rotl32(tmp, 23);
			w[i] = (tmp ^ rotl32(w[i - 13], 7) ^ w[i - 6]) >>> 0;
		}
		const w2 = new Array(64);
		for (let i = 0; i < 64; i++) {
			w2[i] = (w[i] ^ w[i + 4]) >>> 0;
		}

		// 64 轮压缩
		let [a, b, c, d, e, f, g, h] = reg;
		for (let j = 0; j < 64; j++) {
			const ss1 = rotl32((rotl32(a, 12) + e + rotl32(sm3T(j), j % 32)) >>> 0, 7);
			const ss2 = (ss1 ^ rotl32(a, 12)) >>> 0;
			const tt1 = (sm3FF(j, a, b, c) + d + ss2 + w2[j]) >>> 0;
			const tt2 = (sm3GG(j, e, f, g) + h + ss1 + w[j]) >>> 0;
			d = c;
			c = rotl32(b, 9);
			b = a;
			a = tt1;
			h = g;
			g = rotl32(f, 19);
			f = e;
			e = sm3P0(tt2);
		}
		const next = [a, b, c, d, e, f, g, h];
		for (let i = 0; i < 8; i++) {
			reg[i] = (reg[i] ^ next[i]) >>> 0;
		}
	}

	const out = new Array(32);
	for (let i = 0; i < 8; i++) {
		out[i * 4] = (reg[i] >>> 24) & 0xff;
		out[i * 4 + 1] = (reg[i] >>> 16) & 0xff;
		out[i * 4 + 2] = (reg[i] >>> 8) & 0xff;
		out[i * 4 + 3] = reg[i] & 0xff;
	}
	return out;
}

// ---------- RC4 ----------
function rc4(text, key) {
	const s = [];
	for (let i = 0; i < 256; i++) {
		s[i] = i;
	}
	let j = 0;
	for (let i = 0; i < 256; i++) {
		j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
		const tmp = s[i];
		s[i] = s[j];
		s[j] = tmp;
	}
	let i = 0;
	j = 0;
	const out = [];
	for (let k = 0; k < text.length; k++) {
		i = (i + 1) % 256;
		j = (j + s[i]) % 256;
		const tmp = s[i];
		s[i] = s[j];
		s[j] = tmp;
		out.push(String.fromCharCode(s[(s[i] + s[j]) % 256] ^ text.charCodeAt(k)));
	}
	return out.join('');
}

// ---------- 抖音私有 Base64（3 字节 → 4 字符，字符表自定） ----------
const B64_TABLE_UA = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe'; // UA 哈希编码用
const B64_TABLE_MAIN = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe'; // 结果编码用

function customBase64(input, table) {
	let result = '';
	const groups = Math.ceil(input.length / 3);
	for (let g = 0; g < groups; g++) {
		const base = g * 3;
		const b0 = input.charCodeAt(base);
		const b1 = base + 1 < input.length ? input.charCodeAt(base + 1) : 0;
		const b2 = base + 2 < input.length ? input.charCodeAt(base + 2) : 0;
		const packed = ((b0 << 16) | (b1 << 8) | b2) >>> 0;
		// 末组按剩余字节数截断输出（1 字节→2 字符、2 字节→3 字符），不补 '='
		const rem = input.length - base;
		result += table[(packed >> 18) & 63] + table[(packed >> 12) & 63];
		if (rem >= 2) {
			result += table[(packed >> 6) & 63];
		}
		if (rem >= 3) {
			result += table[packed & 63];
		}
	}
	return result;
}

// ---------- 固定环境指纹（伪装屏幕/系统参数，服务端仅做校验一致性） ----------
const WINDOW_ENV_STR = '1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32';
const SUFFIX = 'cus'; // 固定后缀（逆向结论）
const RC4_UA_KEY = String.fromCharCode(0, 1, 14); // UA 哈希前的 RC4 密钥
const RC4_MAIN_KEY = String.fromCharCode(121); // 主字节块的 RC4 密钥

/** 12 字节随机前缀：三组随机数与固定掩码交织（公开逆向结论） */
function buildRandomPrefix() {
	const groups = [
		[3, 45],
		[1, 0],
		[1, 5],
	];
	const bytes = [];
	for (const [opt0, opt1] of groups) {
		const rand = Math.floor(Math.random() * 10000);
		bytes.push(
			(rand & 255 & 170) | (opt0 & 85),
			(rand & 255 & 85) | (opt0 & 170),
			((rand >> 8) & 255 & 170) | (opt1 & 85),
			((rand >> 8) & 255 & 85) | (opt1 & 170)
		);
	}
	return bytes;
}

/**
 * 构造主字节块（bb）：
 * 时间戳字节 + Arguments 标记 + 三组 SM3 哈希特征位 + 环境串字节 + 异或校验位
 */
function buildBbBlob(urlSearchParams, userAgent) {
	const startTime = Date.now();

	// 三次 SM3：查询串+后缀（双重）、后缀（双重）、UA（RC4→Base64→单次）
	const paramsHash = sm3(sm3(urlSearchParams + SUFFIX));
	const suffixHash = sm3(sm3(SUFFIX));
	const uaHash = sm3(customBase64(rc4(userAgent, RC4_UA_KEY), B64_TABLE_UA));
	const endTime = Date.now();

	// 固定应用参数（公开逆向结论中的常量）
	const AID = 6383;
	const PAGE_ID = 6241;
	const ARGS = [0, 1, 14];
	const VERSION_FLAG = 44;

	const b = {};
	// 时间相关（高 3 字节不掩码：2026 年时间戳 /2^32 ≈ 415 > 255，与参考实现一致）
	b.t20 = (startTime >>> 24) & 255;
	b.t21 = (startTime >>> 16) & 255;
	b.t22 = (startTime >>> 8) & 255;
	b.t23 = startTime & 255;
	b.t24 = Math.floor(startTime / 2 ** 32);
	b.t25 = Math.floor(startTime / 2 ** 40);
	// Arguments 字节
	b.a26 = (ARGS[0] >>> 24) & 255;
	b.a27 = (ARGS[0] >>> 16) & 255;
	b.a28 = (ARGS[0] >>> 8) & 255;
	b.a29 = ARGS[0] & 255;
	b.a30 = Math.floor(ARGS[1] / 256) & 255;
	b.a31 = (ARGS[1] % 256) & 255;
	b.a32 = (ARGS[1] >>> 24) & 255;
	b.a33 = (ARGS[1] >>> 16) & 255;
	b.a34 = (ARGS[2] >>> 24) & 255;
	b.a35 = (ARGS[2] >>> 16) & 255;
	b.a36 = (ARGS[2] >>> 8) & 255;
	b.a37 = ARGS[2] & 255;
	// 哈希特征位（取第 21/22、23/24 字节）
	b.h38 = paramsHash[21];
	b.h39 = paramsHash[22];
	b.h40 = suffixHash[21];
	b.h41 = suffixHash[22];
	b.h42 = uaHash[23];
	b.h43 = uaHash[24];
	// 结束时间
	b.e44 = (endTime >>> 24) & 255;
	b.e45 = (endTime >>> 16) & 255;
	b.e46 = (endTime >>> 8) & 255;
	b.e47 = endTime & 255;
	b.e48 = 3; // 固定标记（start-time 低位组的版本位）
	b.e49 = Math.floor(endTime / 2 ** 32);
	b.e50 = Math.floor(endTime / 2 ** 40);
	// pageId / aid 字节
	b.p52 = (PAGE_ID >>> 24) & 255;
	b.p53 = (PAGE_ID >>> 16) & 255;
	b.p54 = (PAGE_ID >>> 8) & 255;
	b.p55 = PAGE_ID & 255;
	b.g56 = AID & 255;
	b.g57 = (AID >>> 8) & 255;
	b.g58 = (AID >>> 16) & 255;
	b.g59 = (AID >>> 24) & 255;
	// 环境串长度
	const envBytes = [];
	for (let i = 0; i < WINDOW_ENV_STR.length; i++) {
		envBytes.push(WINDOW_ENV_STR.charCodeAt(i));
	}
	b.v64 = envBytes.length;
	b.v65 = b.v64 & 255;
	b.v66 = (b.v64 >> 8) & 255;
	// 空数组长度标记（保持为 0）
	b.x70 = 0;
	b.x71 = 0;

	// 异或校验位
	b.xor72 =
		VERSION_FLAG ^ b.t20 ^ b.a26 ^ b.a30 ^ b.h38 ^ b.h40 ^ b.h42 ^ b.t21 ^ b.a27 ^ b.a31 ^ b.a35 ^ b.h39 ^
		b.h41 ^ b.h43 ^ b.t22 ^ b.a28 ^ b.a32 ^ b.a36 ^ b.t23 ^ b.a29 ^ b.a33 ^ b.a37 ^ b.e44 ^ b.e45 ^ b.e46 ^
		b.e47 ^ b.e48 ^ b.e49 ^ b.e50 ^ b.t24 ^ b.t25 ^ b.p52 ^ b.p53 ^ b.p54 ^ b.p55 ^ b.g56 ^ b.g57 ^ b.g58 ^
		b.g59 ^ b.v65 ^ b.v66 ^ b.x70 ^ b.x71;

	// 固定顺序拼装（44 字节骨架 + 环境串 + 校验位），与公开逆向结论一致
	// 注意：aid 字节序为 [>>8, &255, >>16, >>24] 分布在骨架第 6/17/24/32 位
	const blob = [
		VERSION_FLAG, b.t20, b.p52, b.a26, b.a30, b.a34, b.g57, b.h38, b.h40, b.p53, b.h42, b.t21, b.a27, b.p54, b.p55, b.a31,
		b.a35, b.g56, b.h39, b.h41, b.h43, b.t22, b.a28, b.a32, b.g59, b.a36, b.t23, b.a29, b.a33, b.a37, b.e44, b.e45,
		b.g58, b.e46, b.e47, b.e48, b.e49, b.e50, b.t24, b.t25, b.v65, b.v66, b.x70, b.x71,
	].concat(envBytes, [b.xor72]);

	// 关键步骤：拼装结果需再经 RC4（密钥 [121]）加密后返回
	return rc4(String.fromCharCode.apply(null, blob), RC4_MAIN_KEY);
}

/**
 * 生成 a_bogus 参数值
 * @param {string} urlSearchParams 已编码的查询串（不含 a_bogus）
 * @param {string} userAgent 与实际请求一致的 UA
 */
function signA_bogus(urlSearchParams, userAgent) {
	const randomPrefix = buildRandomPrefix();
	const blob = buildBbBlob(urlSearchParams, userAgent);
	const merged = String.fromCharCode.apply(null, randomPrefix) + blob;
	return customBase64(merged, B64_TABLE_MAIN) + '=';
}

/**
 * 对抖音接口 URL 追加 a_bogus 签名
 * @param {string} url 完整 URL（查询串中不包含 a_bogus）
 * @param {string} userAgent 实际请求使用的 UA
 * @returns {string} 签名后的 URL
 */
function signDouyinUrl(url, userAgent) {
	const qIndex = url.indexOf('?');
	if (qIndex === -1) {
		return url;
	}
	const base = url.slice(0, qIndex);
	const query = url.slice(qIndex + 1);
	return `${base}?${query}&a_bogus=${encodeURIComponent(signA_bogus(query, userAgent))}`;
}

module.exports = { signDouyinUrl, signA_bogus };
// 供验证脚本分层比对（发布前如不需要可保留，不影响主流程）
module.exports.__debug = { sm3, rc4, customBase64, buildBbBlob, B64_TABLE_UA, B64_TABLE_MAIN, WINDOW_ENV_STR };
