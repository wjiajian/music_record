// 网易云 WEAPI 加密：AES-128-CBC 双层 + 自定义 RSA。常量多年稳定。
import crypto from 'node:crypto';

const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const EAPI_KEY = 'e82ckenh8dichen8';
const IV = '0102030405060708';
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PUB_MOD =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725' +
  '152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312' +
  'ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424' +
  'd813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const PUB_EXP = '010001';

// AES-128-CBC，输出 base64
function aesEncrypt(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function aesEcbEncryptHex(text, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

// 自定义 RSA：无填充，secretKey 反转后按字节做 b^e mod n，输出零填充到 256 位十六进制
function rsaEncrypt(text) {
  const reversed = text.split('').reverse().join('');
  const b = BigInt('0x' + Buffer.from(reversed, 'utf8').toString('hex'));
  return modPow(b, BigInt('0x' + PUB_EXP), BigInt('0x' + PUB_MOD))
    .toString(16)
    .padStart(256, '0');
}

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function randomKey(len = 16) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += BASE62[bytes[i] % 62];
  return s;
}

// 把任意 payload 对象加密成 weapi 的 { params, encSecKey }
export function weapi(payload) {
  const text = JSON.stringify(payload);
  const secretKey = randomKey(16);
  const params = aesEncrypt(aesEncrypt(text, PRESET_KEY), secretKey);
  const encSecKey = rsaEncrypt(secretKey);
  return { params, encSecKey };
}

export function eapi(uri, payload) {
  const text = JSON.stringify(payload);
  const digest = crypto.createHash('md5').update(`nobody${uri}use${text}md5forencrypt`).digest('hex');
  const data = `${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return { params: aesEcbEncryptHex(data, EAPI_KEY) };
}
