/* ============================================================
 * bilibili-core.js — B站数据层：接口常量、归一化数据模型、API 客户端
 * 仅负责数据获取与解析，不依赖 vscode UI 组件。
 * ============================================================ */
'use strict';

const {
	REQUEST_TIMEOUT_MS,
	FEED_DISPLAY_LIMIT,
	readConfig,
	ensureHttps,
	formatDuration,
	formatCount,
	stripHighlightTags,
	parseDurationToSeconds,
	isCookieExpiredCode,
	extractCookiePairs,
} = require('./shared');

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

module.exports = {
	// 常量（UI 层扫码轮询/分页复用）
	LOGIN_POLL_INTERVAL_MS,
	QR_STATE_SUCCESS,
	QR_STATE_EXPIRED,
	QR_STATE_CONFIRMED,
	QR_STATE_NOT_SCANNED,
	WATCHLATER_PAGE_SIZE,
	// 模型与客户端
	VideoEntry,
	VideoFeedClient,
	serializeEntry,
	serializeLiveRoom,
};
