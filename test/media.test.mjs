import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/paths.mjs';
import { DEFAULT_MEDIA_OPTIONS, MediaStore, StickerLibrary, imageParts } from '../src/media.mjs';

// Actual 1x1 PNG; no image or network service is involved in these tests.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64');
const URL = 'https://gchat.qpic.cn/test-image.png';
const DAY = 86400000;
const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];
function temp() {
  const parent = path.join(ROOT, 'test-output'); fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, 'media-'));
}
function fixture(overrides = {}, dependencies = {}) {
  const root = temp(), requests = [], options = { ...DEFAULT_MEDIA_OPTIONS, ...overrides };
  let time = Date.parse('2026-11-11T12:00:00+08:00');
  const clock = () => time;
  const fetchImpl = dependencies.fetchImpl ?? (async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
  });
  const deps = { clock, fetchImpl, lookupImpl: dependencies.lookupImpl ?? publicLookup };
  return { root, requests, options, deps, store: new MediaStore(root, options, deps), advance: ms => { time += ms; }, reopen: () => new MediaStore(root, options, deps) };
}
const image = data => ({ type: 'image', data });
const noOneBot = { call: async () => { throw Error('Unexpected OneBot action'); } };

test('只从真实图片段提取一张附件，支持 CQ 解码，不把普通文字当图片', () => {
  const parts = imageParts([{ type: 'text', data: { text: '看看这张' } }, image({ file: 'first.image', url: URL }), image({ file: 'second.image', url: URL })]);
  assert.equal(parts.length, 1); assert.equal(parts[0].type, 'image'); assert.equal(parts[0].data.file, 'first.image');
  const cq = imageParts('看看[CQ:image,file=one.image,url=https://gchat.qpic.cn/a.png?x=1&amp;y=2][CQ:image,file=two.image]');
  assert.equal(cq.length, 1); assert.equal(cq[0].data.file, 'one.image'); assert.match(cq[0].data.url, /x=1&y=2/);
  assert.deepEqual(imageParts('https://gchat.qpic.cn/a.png 普通文字'), []);
});

test('QQ 媒体图片转换为低分辨率多模态附件，原图缓存只写指定 E 盘项目目录', async () => {
  const f = fixture();
  const result = await f.store.prepareImage(image({ file: 'qq-cache-id.image', url: URL }), noOneBot);
  assert.equal(result.part.type, 'image_url'); assert.equal(result.part.image_url.detail, 'low');
  assert.match(result.part.image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(result.part.image_url.url.split(',')[1], 'base64'), PNG);
  assert.equal(result.estimatedTokens, 1120);
  const cache = path.join(f.root, 'data', 'media'); assert.ok(fs.existsSync(cache));
  const files = fs.readdirSync(cache, { recursive: true, withFileTypes: true }).filter(x => x.isFile());
  assert.ok(files.length > 0);
  for (const file of files) {
    const full = fs.realpathSync(path.join(file.parentPath ?? file.path, file.name));
    assert.ok(full.startsWith(fs.realpathSync(cache) + path.sep));
  }
});

test('没有直链时只通过当前 OneBot 图片缓存 ID 取图', async () => {
  const f = fixture(), calls = [];
  const onebot = { call: async (action, params) => { calls.push({ action, params }); return { url: URL }; } };
  const result = await f.store.prepareImage(image({ file: 'cached-in-current-account.image' }), onebot);
  assert.match(result.part.image_url.url, /^data:image\/png;base64,/);
  assert.equal(calls[0].action, 'get_image'); assert.equal(calls[0].params.file, 'cached-in-current-account.image');
});

test('拒绝任意 URL、本机文件和解析到内网的 QQ 媒体地址', async () => {
  const f = fixture();
  for (const url of ['https://example.com/a.png', 'http://127.0.0.1/a.png', 'file:///C:/Users/private.txt', 'https://gchat.qpic.cn.evil.example/a.png']) {
    await assert.rejects(async () => f.store.prepareImage(image({ url }), noOneBot));
  }
  assert.equal(f.requests.length, 0);
  const privateDns = fixture({}, { lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(async () => privateDns.store.prepareImage(image({ url: URL }), noOneBot));
  assert.equal(privateDns.requests.length, 0);
});

test('下载重定向逐跳检查，拒绝转到外域或内网', async () => {
  const seen = [];
  const f = fixture({}, { fetchImpl: async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(null, { status: 302, headers: { location: 'https://example.com/stolen.png' } });
  } });
  await assert.rejects(async () => f.store.prepareImage(image({ url: URL }), noOneBot));
  assert.equal(seen.length, 1); assert.equal(seen[0].init.redirect, 'manual');
});

test('文件大小与实际格式都受限，GIF 和伪装成图片的正文不进入视觉请求', async () => {
  const oversized = fixture({ maxImageBytes: 80 }, { fetchImpl: async () => new Response(Buffer.concat([PNG, Buffer.alloc(100)]), { headers: { 'content-type': 'image/png' } }) });
  await assert.rejects(async () => oversized.store.prepareImage(image({ url: URL }), noOneBot));
  for (const content of [Buffer.from('GIF89a' + 'not-a-supported-still-image'), Buffer.from('<html>not an image</html>')]) {
    const f = fixture({}, { fetchImpl: async () => new Response(content, { headers: { 'content-type': 'image/png' } }) });
    await assert.rejects(async () => f.store.prepareImage(image({ url: URL }), noOneBot));
  }
});

test('图片次数在调用前预留，跨重启保留每日与累计上限', async () => {
  const f = fixture({ maxImagesPerDay: 2, maxImagesTotal: 3 });
  await f.store.reserveImage(); await f.store.reserveImage();
  await assert.rejects(async () => f.reopen().reserveImage());
  f.advance(DAY);
  const next = f.reopen(); await next.reserveImage();
  await assert.rejects(async () => f.reopen().reserveImage());
  assert.ok(fs.existsSync(path.join(f.root, 'data', 'media-usage.json')));
});

test('本地图按情绪挑选，不需要模型，概率与冷却限制生效', () => {
  const root = temp(), folder = path.join(root, 'assets', 'stickers', 'hissing');
  fs.mkdirSync(folder, { recursive: true }); const file = path.join(folder, 'cat.png'); fs.writeFileSync(file, PNG);
  let time = Date.parse('2026-11-11T12:00:00+08:00');
  const options = { ...DEFAULT_MEDIA_OPTIONS, stickersEnabled: true, stickerProbability: 0.2, stickerCooldownMs: 60000 };
  const library = new StickerLibrary(root, options, { clock: () => time, random: () => 0 });
  assert.equal(fs.realpathSync(library.choose('哈？你这逻辑')), fs.realpathSync(file));
  assert.equal(library.choose('哈？'), null);
  time += 60001; assert.equal(fs.realpathSync(library.choose('嘶——')), fs.realpathSync(file));
  const noChance = new StickerLibrary(root, options, { clock: () => time, random: () => 1 });
  assert.equal(noChance.choose('哈？'), null);
});

test('图库拒绝通过目录链接选择库外文件', t => {
  const root = temp(), libraryRoot = path.join(root, 'assets', 'stickers'), outside = path.join(root, 'outside-library');
  fs.mkdirSync(libraryRoot, { recursive: true }); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'cat.png'), PNG);
  try { fs.symlinkSync(outside, path.join(libraryRoot, 'hissing'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('当前执行环境不允许创建目录链接'); return; } throw error; }
  const library = new StickerLibrary(root, { ...DEFAULT_MEDIA_OPTIONS, stickerProbability: 0.2 }, { random: () => 0 });
  assert.equal(library.choose('哈？'), null);
});

test('新表情按语气选图，嘲讽不被开头哈字抢走，同情绪有替代时不连发同图', () => {
  const root = temp();
  for (const [category, names] of [['mock', ['典中典', '咧嘴笑', '大笑', '笑疯了']], ['smug', ['开心', '笑眯眯', '就这', '赢麻了']], ['angry', ['急了', '再说一遍']]]) {
    const dir = path.join(root, 'assets', 'stickers', category); fs.mkdirSync(dir, { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(dir, name + '.png'), PNG);
  }
  const library = new StickerLibrary(root, { stickersEnabled: true, stickerProbability: 1, stickerCooldownMs: 0 }, { random: () => 0 });
  assert.equal(path.basename(library.choose('哈？你这台词又复读了')), '典中典.png');
  assert.notEqual(path.basename(library.choose('台词都盘出包浆了')), '典中典.png');
  assert.equal(path.basename(library.choose('绷不住了笑疯了')), '笑疯了.png');
  assert.equal(path.basename(library.choose('开心，好耶')), '开心.png');
  assert.equal(path.basename(library.choose('开心')), '笑眯眯.png');
  assert.equal(path.basename(library.choose('就这点水平')), '就这.png');
  assert.equal(path.basename(library.choose('急了急了')), '急了.png');
  assert.equal(library.choose('认真讨论一下这道数学题'), null);
});

test('主人看图豁免每日累计次数并独立记账，不挤占普通群友配额', () => {
  const f = fixture({ maxImagesPerDay: 1, maxImagesTotal: 1 });
  f.store.reserveImage({ exempt: true }); f.store.reserveImage({ exempt: true });
  f.store.reserveImage();
  const reopened = f.reopen();
  assert.equal(reopened.state.totalImages, 3); assert.equal(reopened.state.ownerTotalImages, 2);
  assert.throws(() => reopened.reserveImage(), /上限/);
  reopened.reserveImage({ exempt: true }); assert.equal(reopened.state.totalImages, 4);
});

test('乐子人新表情按语气命中，吃瓜看戏重复只在同类轮换，保持概率和冷却', () => {
  const root=temp();
  for(const [category,names]of [['mock',['偷笑','看戏','憋笑','吃瓜','典中典']],['smug',['拿捏了','就这']]]){
    const folder=path.join(root,'assets','stickers',category);fs.mkdirSync(folder,{recursive:true});
    for(const name of names)fs.writeFileSync(path.join(folder,name+'.png'),PNG);
  }
  const options={stickersEnabled:true,stickerProbability:1,stickerCooldownMs:10000};let now=0;
  const lib=new StickerLibrary(root,options,{clock:()=>now,random:()=>0});
  for(const [text,file]of [['偷笑一下','偷笑.png'],['嘴角压不住了，憋笑','憋笑.png'],['前排看戏','看戏.png'],['有瓜，吃瓜','吃瓜.png'],['本猫出马，这还不拿捏','拿捏了.png']]){
    assert.equal(path.basename(lib.choose(text)),file);assert.equal(lib.choose(text),null);now+=10001;
  }
  assert.equal(path.basename(lib.choose('继续吃瓜')),'吃瓜.png');now+=10001;
  assert.equal(path.basename(lib.choose('吃瓜')),'看戏.png');
  const off=new StickerLibrary(root,{...options,stickerProbability:0},{random:()=>0});assert.equal(off.choose('吃瓜'),null);
});
