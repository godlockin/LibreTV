// /api/proxy/[...path].mjs - Vercel Serverless Function (ES Module)

import fetch from 'node-fetch';
import { URL } from 'url'; // 使用 Node.js 内置 URL 处理

// --- 配置 (从环境变量读取) ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10); // 默认 24 小时
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '5', 10); // 默认 5 层

// --- User Agent 处理 ---
// 默认 User Agent 列表
let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
// 尝试从环境变量读取并解析 USER_AGENTS_JSON
try {
    const agentsJsonString = process.env.USER_AGENTS_JSON;
    if (agentsJsonString) {
        const parsedAgents = JSON.parse(agentsJsonString);
        // 检查解析结果是否为非空数组
        if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
            USER_AGENTS = parsedAgents; // 使用环境变量中的数组
            console.log(`[代理日志] 已从环境变量加载 ${USER_AGENTS.length} 个 User Agent。`);
        } else {
            console.warn("[代理日志] 环境变量 USER_AGENTS_JSON 不是有效的非空数组，使用默认值。");
        }
    } else {
        console.log("[代理日志] 未设置环境变量 USER_AGENTS_JSON，使用默认 User Agent。");
    }
} catch (e) {
    // 如果 JSON 解析失败，记录错误并使用默认值
    console.error(`[代理日志] 解析环境变量 USER_AGENTS_JSON 出错: ${e.message}。使用默认 User Agent。`);
}

// 广告过滤在代理中禁用，由播放器处理
const FILTER_DISCONTINUITY = false;


// --- 辅助函数 ---

function logDebug(message) {
    if (DEBUG_ENABLED) {
        console.log(`[代理日志] ${message}`);
    }
}

/**
 * 从代理请求路径中提取编码后的目标 URL。
 * @param {string} encodedPath - URL 编码后的路径部分 (例如 "https%3A%2F%2F...")
 * @returns {string|null} 解码后的目标 URL，如果无效则返回 null。
 */
function getTargetUrlFromPath(encodedPath) {
    if (!encodedPath) {
        logDebug("getTargetUrlFromPath 收到空路径。");
        return null;
    }
    try {
        const decodedUrl = decodeURIComponent(encodedPath);
        // 基础检查，看是否像一个 HTTP/HTTPS URL
        if (decodedUrl.match(/^https?:\/\/.+/i)) {
            return decodedUrl;
        } else {
            logDebug(`无效的解码 URL 格式: ${decodedUrl}`);
            // 备选检查：原始路径是否未编码但看起来像 URL？
            if (encodedPath.match(/^https?:\/\/.+/i)) {
                logDebug(`警告: 路径未编码但看起来像 URL: ${encodedPath}`);
                return encodedPath;
            }
            return null;
        }
    } catch (e) {
        // 捕获解码错误 (例如格式错误的 URI)
        logDebug(`解码目标 URL 出错: ${encodedPath} - ${e.message}`);
        return null;
    }
}

function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        // 处理根目录或只有文件名的情况
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean); // 移除空字符串
        if (pathSegments.length <= 1) {
            return `${parsedUrl.origin}/`;
        }
        pathSegments.pop(); // 移除最后一段
        return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) {
        logDebug(`获取 BaseUrl 失败: "${urlStr}": ${e.message}`);
        // 备用方法：查找最后一个斜杠
        const lastSlashIndex = urlStr.lastIndexOf('/');
        if (lastSlashIndex > urlStr.indexOf('://') + 2) { // 确保不是协议部分的斜杠
            return urlStr.substring(0, lastSlashIndex + 1);
        }
        return urlStr + '/'; // 如果没有路径，添加斜杠
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return ''; // 处理空的 relativeUrl
    if (relativeUrl.match(/^https?:\/\/.+/i)) {
        return relativeUrl; // 已经是绝对 URL
    }
    if (!baseUrl) return relativeUrl; // 没有基础 URL 无法解析

    try {
        // 使用 Node.js 的 URL 构造函数处理相对路径
        return new URL(relativeUrl, baseUrl).toString();
    } catch (e) {
        logDebug(`URL 解析失败: base="${baseUrl}", relative="${relativeUrl}". 错误: ${e.message}`);
        // 简单的备用逻辑
        if (relativeUrl.startsWith('/')) {
             try {
                const baseOrigin = new URL(baseUrl).origin;
                return `${baseOrigin}${relativeUrl}`;
             } catch { return relativeUrl; } // 如果 baseUrl 也无效，返回原始相对路径
        } else {
            // 假设相对于包含基础 URL 资源的目录
            return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`;
        }
    }
}

// ** 已修正：确保生成 /proxy/ 前缀的链接 **
function rewriteUrlToProxy(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    // 返回与 vercel.json 的 "source" 和前端 PROXY_URL 一致的路径
    return `/proxy/${encodeURIComponent(targetUrl)}`;
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchContentWithType(targetUrl, requestHeaders) {
    // 准备请求头
    const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': requestHeaders['accept'] || '*/*', // 传递原始 Accept 头（如果有）
        'Accept-Language': requestHeaders['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        // 尝试设置一个合理的 Referer
        'Referer': requestHeaders['referer'] || new URL(targetUrl).origin,
    };
    // 清理空值的头
    Object.keys(headers).forEach(key => headers[key] === undefined || headers[key] === null || headers[key] === '' ? delete headers[key] : {});

    logDebug(`准备请求目标: ${targetUrl}，请求头: ${JSON.stringify(headers)}`);

    try {
        // 发起 fetch 请求
        const response = await fetch(targetUrl, { headers, redirect: 'follow' });

        // 检查响应是否成功
        if (!response.ok) {
            const errorBody = await response.text().catch(() => ''); // 尝试获取错误响应体
            logDebug(`请求失败: ${response.status} ${response.statusText} - ${targetUrl}`);
            // 创建一个包含状态码的错误对象
            const err = new Error(`HTTP 错误 ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
            err.status = response.status; // 将状态码附加到错误对象
            throw err; // 抛出错误
        }

        // 读取响应内容
        const content = await response.text();
        const contentType = response.headers.get('content-type') || '';
        logDebug(`请求成功: ${targetUrl}, Content-Type: ${contentType}, 内容长度: ${content.length}`);
        // 返回结果
        return { content, contentType, responseHeaders: response.headers };

    } catch (error) {
        // 捕获 fetch 本身的错误（网络、超时等）或上面抛出的 HTTP 错误
        logDebug(`请求异常 ${targetUrl}: ${error.message}`);
        // 重新抛出，确保包含原始错误信息
        throw new Error(`请求目标 URL 失败 ${targetUrl}: ${error.message}`);
    }
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
        return true;
    }
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processKeyLine(line, baseUrl) {
    return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 KEY URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
    });
}

function processMapLine(line, baseUrl) {
     return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`处理 MAP URI: 原始='${uri}', 绝对='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
    });
}

/**
 * 处理 M3U8 内容，重写其中的 URL。
 * @param {string} m3u8Content - M3U8 文件的文本内容。
 * @param {string} baseUrl - M3U8 文件自身的 URL，用于解析相对路径。
 * @param {number} [recursionDepth=0] - 当前递归深度。
 * @returns {Promise<string>} 处理后的 M3U8 内容。
 */
async function processM3u8(m3u8Content, baseUrl, recursionDepth = 0) {
    logDebug(`开始处理 M3U8 (深度 ${recursionDepth}): ${baseUrl}`);

    if (recursionDepth > MAX_RECURSION) {
        logDebug(`M3U8 处理达到最大递归深度 (${MAX_RECURSION})，停止处理: ${baseUrl}`);
        return m3u8Content; // 返回原始内容以避免无限递归
    }

    const lines = m3u8Content.split(/\r?\n/);
    const processedLines = [];
    let isVariantPlaylist = false;

    for (const line of lines) {
        let processedLine = line.trim();

        if (processedLine.startsWith('#EXT-X-STREAM-INF:')) {
            isVariantPlaylist = true;
            // 对于主播放列表中的流信息行，也需要处理其 URI (如果存在)
            // 通常 URI 在下一行，但规范允许在同一行，例如：
            // #EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000,URI="stream.m3u8"
            // 但更常见的是 URI 在下一行，所以我们主要处理下一行
            processedLines.push(processedLine);
        } else if (processedLine.startsWith('#EXT-X-KEY:')) {
            processedLines.push(processKeyLine(processedLine, baseUrl));
        } else if (processedLine.startsWith('#EXT-X-MAP:')) {
            processedLines.push(processMapLine(processedLine, baseUrl));
        } else if (processedLine.startsWith('#EXTINF:') || processedLine.startsWith('#EXT-X-BYTERANGE:')) {
            // 这些标签后面通常跟着媒体片段的 URL
            processedLines.push(processedLine);
        } else if (processedLine && !processedLine.startsWith('#')) {
            // 这应该是一个 URL (媒体片段或子 M3U8)
            const segmentUrl = resolveUrl(baseUrl, processedLine);
            logDebug(`原始片段/子M3U8 URL: '${processedLine}', 解析后: '${segmentUrl}'`);

            // 尝试获取这个 URL 的内容类型，判断是否是嵌套的 M3U8
            // 但为了避免对每个片段都发起 HEAD 请求，我们先假设它可能是 M3U8
            // 如果这是一个主播放列表 (isVariantPlaylist 为 true)，那么这行很可能是子 M3U8
            // 如果这是一个媒体播放列表，那么这行是媒体片段
            if (isVariantPlaylist || segmentUrl.toLowerCase().endsWith('.m3u8') || segmentUrl.toLowerCase().endsWith('.m3u')) {
                try {
                    logDebug(`尝试获取并处理嵌套 M3U8: ${segmentUrl} (来自 ${baseUrl})`);
                    // 注意：这里不直接发起请求，而是生成代理 URL
                    // 嵌套的 M3U8 也应该通过代理访问
                    processedLines.push(rewriteUrlToProxy(segmentUrl));
                } catch (fetchError) {
                    logDebug(`获取嵌套 M3U8 失败 (${segmentUrl}): ${fetchError.message}。作为普通片段处理。`);
                    processedLines.push(rewriteUrlToProxy(segmentUrl)); // 失败则按原样（代理后）加入
                }
            } else {
                // 普通媒体片段，直接重写 URL
                processedLines.push(rewriteUrlToProxy(segmentUrl));
            }
        } else {
            // 其他 M3U8 标签或空行
            processedLines.push(processedLine);
        }
    }
    return processedLines.join('\n');
}


// --- Vercel Serverless Function Handler (ES Module) ---
export default async function handler(request, response) {
    const { path } = request.query; // 从查询参数中获取路径，Vercel 会自动处理 [...path]
    const encodedTargetUrl = Array.isArray(path) ? path.join('/') : path;

    logDebug(`收到代理请求: ${request.url}, 原始路径参数: ${JSON.stringify(request.query.path)} -> ${encodedTargetUrl}`);

    const targetUrl = getTargetUrlFromPath(encodedTargetUrl);

    if (!targetUrl) {
        logDebug("无效的目标 URL，返回 400 错误。");
        response.status(400).send('错误：无效的目标 URL。请提供正确的编码 URL 作为路径。例如 /api/proxy/https%3A%2F%2Fexample.com');
        return;
    }

    logDebug(`解码后的目标 URL: ${targetUrl}`);

    // 检查是否是 OPTIONS 请求 (CORS 预检)
    if (request.method === 'OPTIONS') {
        logDebug("处理 OPTIONS 预检请求。");
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range, Authorization');
        response.setHeader('Access-Control-Max-Age', '86400'); // 24小时
        response.status(204).end();
        return;
    }

    // 设置通用的 CORS 头
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Date, Server, Transfer-Encoding, X-Powered-By');

    try {
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, request.headers);

        // 传递原始响应头 (部分)
        // 'content-length', 'content-type', 'date', 'server' 等通常由 fetch 的 Response 对象自动处理或下游服务器设置
        // 但有些头可能需要手动传递，例如 'content-disposition', 'cache-control' 等
        // 这里我们选择性地传递一些常见的头
        const headersToForward = ['content-type', 'cache-control', 'expires', 'last-modified', 'etag', 'content-disposition', 'content-range', 'accept-ranges'];
        responseHeaders.forEach((value, name) => {
            if (headersToForward.includes(name.toLowerCase())) {
                response.setHeader(name, value);
            }
        });

        if (isM3u8Content(content, contentType)) {
            logDebug(`检测到 M3U8 内容，开始处理: ${targetUrl}`);
            const baseUrlForM3u8 = getBaseUrl(targetUrl);
            const processedM3u8 = await processM3u8(content, baseUrlForM3u8);
            logDebug(`M3U8 处理完成: ${targetUrl}`);
            response.setHeader('Content-Type', contentType || 'application/vnd.apple.mpegurl'); // 确保正确的MIME类型
            response.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`); // M3U8 文件可以缓存
            response.status(200).send(processedM3u8);
        } else {
            logDebug(`非 M3U8 内容，直接透传: ${targetUrl}`);
            // 对于非 M3U8 内容，通常不需要修改，直接透传
            // 确保 Content-Type 被设置
            if (contentType) {
                response.setHeader('Content-Type', contentType);
            }
            // 尝试设置一个合理的缓存策略，例如，如果源服务器没有指定，则不缓存或短时间缓存
            if (!response.headersSent || !response.getHeader('Cache-Control')) {
                 response.setHeader('Cache-Control', 'public, max-age=3600'); // 默认缓存1小时，除非源已指定
            }
            response.status(200).send(content);
        }
    } catch (error) {
        logDebug(`处理请求时发生错误: ${error.message}`);
        // 根据错误类型返回不同的状态码
        const statusCode = error.status || 500; // 如果错误对象有 status 属性，则使用它
        let errorMessage = `代理请求失败: ${error.message}`;
        if (statusCode === 404) {
            errorMessage = `错误：无法找到目标资源 (404 Not Found)。URL: ${targetUrl}`;
        } else if (statusCode >= 500) {
            errorMessage = `错误：目标服务器错误 (${statusCode})。URL: ${targetUrl}`;
        }
        response.status(statusCode).send(errorMessage);
    }
}
