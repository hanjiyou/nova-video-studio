'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');

// Cache verified identities, never video bytes or open handles. Every request still
// resolves its managed path and opens a fresh handle, so moves/replacements expire it.
function createPreviewReader({ fail, maxEntries = 64 }) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 256) throw new TypeError('Invalid preview cache bound');
    const verified = new Map(), verifying = new Map();
    const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
    const corrupt = () => fail('ASSET_CORRUPT', '素材文件已改变或与摘要不符，记录已保留。', 409);
    async function open(file, asset) {
        let handle;
        const key = asset.id;
        try {
            handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || before.size !== BigInt(asset.byte_length)) throw corrupt();
            const stamp = identity(before), signature = [file, asset.sha256, asset.byte_length, stamp].join('|');
            async function unchanged() {
                const [current, atPath] = await Promise.all([handle.stat({ bigint: true }), fs.promises.lstat(file, { bigint: true })]);
                if (atPath.isSymbolicLink()) throw fail('ASSET_PATH_REJECTED', '受管文件路径不安全。', 409);
                if (identity(current) !== stamp || identity(atPath) !== stamp) throw corrupt();
            }
            await unchanged();
            if (verified.get(key) !== signature) {
                let verification = verifying.get(signature);
                if (!verification) {
                    verification = (async () => {
                        const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(Math.min(256 * 1024, asset.byte_length));
                        let offset = 0;
                        while (offset < asset.byte_length) {
                            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, asset.byte_length - offset), offset);
                            if (!bytesRead) throw corrupt();
                            hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
                        }
                        await unchanged();
                        if (hash.digest('hex') !== asset.sha256) throw corrupt();
                    })();
                    verifying.set(signature, verification);
                    // Keep the promise's rejection handled even if a consumer aborts.
                    verification.finally(() => { if (verifying.get(signature) === verification) verifying.delete(signature); }).catch(() => {});
                }
                await verification;
                await unchanged();
            }
            verified.delete(key); verified.set(key, signature);
            while (verified.size > maxEntries) verified.delete(verified.keys().next().value);
            let closed = false;
            return {
                byteLength: asset.byte_length,
                async read(start = 0, end = asset.byte_length - 1) {
                    if (closed) throw fail('ASSET_READ_CLOSED', '本次媒体读取已结束。', 409);
                    if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end >= asset.byte_length) throw fail('ASSET_RANGE_INVALID');
                    try {
                        await unchanged();
                        const bytes = Buffer.allocUnsafe(end - start + 1);
                        let offset = 0;
                        while (offset < bytes.length) {
                            const { bytesRead } = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), start + offset);
                            if (!bytesRead) throw corrupt();
                            offset += bytesRead;
                        }
                        await unchanged();
                        return bytes;
                    } catch (error) { verified.delete(key); throw error; }
                },
                async close() { if (!closed) { closed = true; await handle.close(); } },
                get closed() { return closed; }
            };
        } catch (error) {
            verified.delete(key);
            if (handle) await handle.close().catch(() => {});
            throw error;
        }
    }
    return { open, get cacheSize() { return verified.size; } };
}
module.exports = { createPreviewReader };
