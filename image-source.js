import https from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',3]]) blocked.addSubnet(ip, bits);
export function publicImageAddress(address) {
  return isIP(address) === 4 ? !blocked.check(address) : isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}

// Pin the validated DNS answer to this request; never follow redirects into a private network.
export function downloadImage(source) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('图片原图下载失败，请重试或将图片下载后上传到素材库'));
    let url;
    try { url = new URL(source); } catch { return fail(); }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || (isIP(host) && !publicImageAddress(host))) return fail();
    const req = https.get(url, {
      signal: AbortSignal.timeout(60000),
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true }, (err, addresses) => {
          if (err || !addresses.length || addresses.some(item => !publicImageAddress(item.address))) return callback(new Error('图片地址不可访问'));
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    }, response => {
      const mime = response.headers['content-type']?.split(';')[0].toLowerCase();
      if (response.statusCode !== 200 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/heic', 'image/heif'].includes(mime)) { response.destroy(); return fail(); }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 30 * 1024 * 1024) { response.destroy(); fail(); }
        else chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => size ? resolve(`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`) : fail());
    });
    req.on('error', fail);
  });
}
