const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');
const { appendMiniMediaSignature, hasValidMiniMediaSignature } = require('../lib/mini-media-signing');
const { toMiniLog } = require('./mini-log-sync');
const { isPublicUploadMediaPath } = require('./upload-access');
const {
  MINI_MACHINE_CONFIG_KEYS,
  mergeMiniMachineConfig,
  synchronizedOwnerInfo,
  validateMiniSupply
} = require('./mini-item-contract');
const {
  isIdempotentProcessedStatus,
  normalizeProcessedStatusForResponse,
  normalizeStatusAction
} = require('./status-idempotency');
const {
  canEnterAdminDashboard,
  createTicketStore,
  dashboardOriginForRequest,
  isAdminDashboardHost
} = require('./admin-dashboard-entry');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_DASHBOARD_PORT = Number(process.env.JUZHEN_ADMIN_DASHBOARD_PORT || 0);
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
const ADMIN_PASSWORD = requireEnv('JUZHEN_ADMIN_PASSWORD');
const VIEW_PASSWORD = requireEnv('JUZHEN_VIEW_PASSWORD');
const MINI_PROGRAM_TOKEN = requireEnv('JUZHEN_MINI_PROGRAM_TOKEN');
const BASE = __dirname;
const PUBLIC = path.join(BASE, 'public');
const MINI_UPLOAD_DIR = path.join(PUBLIC, 'uploads', 'mini');
const WEB_UPLOAD_DIR = path.join(PUBLIC, 'uploads', 'web');
const DATA_DIR = path.join(BASE, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_CONFIG_FILE = process.env.JUZHEN_SEED_CONFIG_FILE || path.join(DATA_DIR, 'seed-config.json');
const SEED_CONFIG = loadSeedConfig(SEED_CONFIG_FILE);
const SUPER_ADMIN_ACCOUNTS = parseSuperAdmins();
const GROUP_APPROVERS = normalizeGroupApprovers(SEED_CONFIG.groupApprovers || {});
const AUTO_APPROVE_OFFLINE_REASONS = new Set([
  '货源已在别处售出',
  '货源已成交',
  '货源已无库存',
  '客户已在别处完成采购',
  '需求已成交',
  '需求已结束',
  '业务已完成'
]);
const SEEDED_USERS = normalizeSeedUsers(SEED_CONFIG.users || []);
const REMOVED_SEEDED_LOGIN_KEYS = new Set((SEED_CONFIG.removedLoginKeys || []).map(key => text(key, 120)).filter(Boolean));
const INITIAL_USER_PASSWORD = process.env.JUZHEN_INITIAL_USER_PASSWORD || '';
const USER_SEED_VERSION = text(SEED_CONFIG.version || process.env.JUZHEN_USER_SEED_VERSION || 'local', 80);
const TEMP_ACCOUNT_PASSWORD = process.env.JUZHEN_TEMP_ACCOUNT_PASSWORD || '';
const TEMP_ACCOUNT_PASSWORD_VERSION = process.env.JUZHEN_TEMP_ACCOUNT_PASSWORD_VERSION || 'disabled';
if (SEEDED_USERS.some(account => !isTemporaryAccount(account)) && !INITIAL_USER_PASSWORD) {
  throw new Error('Missing required environment variable: JUZHEN_INITIAL_USER_PASSWORD');
}
if (SEEDED_USERS.some(account => isTemporaryAccount(account)) && !TEMP_ACCOUNT_PASSWORD) {
  throw new Error('Missing required environment variable: JUZHEN_TEMP_ACCOUNT_PASSWORD');
}
const sessions = new Map();
const userSessions = new Map();
const loginFailures = new Map();
const smsCodes = new Map();
const clients = new Set();
const adminDashboardSessions = new Map();
const adminDashboardTickets = createTicketStore({
  ttlMs: Number(process.env.JUZHEN_ADMIN_DASHBOARD_TICKET_TTL_MS || 60 * 1000)
});
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADMIN_DASHBOARD_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADMIN_DASHBOARD_HOSTS = (process.env.JUZHEN_ADMIN_DASHBOARD_HOSTS || 'admin.rlcgxpt.localhost')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const MINI_BOOTSTRAP_ENABLED = process.env.JUZHEN_ENABLE_MINI_BOOTSTRAP === 'true';
const MOCK_ADMIN_LOGIN_ENABLED = process.env.JUZHEN_ENABLE_MOCK_ADMIN_LOGIN === 'true';
const SENSITIVE_ACTION_MAX_AGE_MS = 10 * 60 * 1000;
const MINI_SESSION_SECRET = process.env.JUZHEN_MINI_SESSION_SECRET || MINI_PROGRAM_TOKEN;
const MINI_MEDIA_SIGNING_SECRET = process.env.JUZHEN_MEDIA_SIGNING_SECRET || MINI_SESSION_SECRET;
const ALLOW_LEGACY_MINI_TOKEN = process.env.JUZHEN_ALLOW_LEGACY_MINI_TOKEN !== 'false';
const SMS_CODE_TTL_MINUTES = Number(process.env.SMS_CODE_TTL_MINUTES || 5);
const SMS_SEND_INTERVAL_SECONDS = Number(process.env.SMS_SEND_INTERVAL_SECONDS || 60);
const SMS_PHONE_DAILY_LIMIT = Number(process.env.SMS_PHONE_DAILY_LIMIT || 10);
const SMS_IP_DAILY_LIMIT = Number(process.env.SMS_IP_DAILY_LIMIT || 100);
const SMS_VERIFY_MAX_ATTEMPTS = Number(process.env.SMS_VERIFY_MAX_ATTEMPTS || 5);
const SMS_CONFIG = {
  secretId: process.env.TENCENTCLOUD_SECRET_ID || '',
  secretKey: process.env.TENCENTCLOUD_SECRET_KEY || '',
  SdkAppId: process.env.TENCENTCLOUD_SMS_SDK_APP_ID || '',
  TemplateId: process.env.TENCENTCLOUD_SMS_TEMPLATE_ID || '',
  SignName: process.env.TENCENTCLOUD_SMS_SIGN_NAME || '',
  region: process.env.TENCENTCLOUD_SMS_REGION || 'ap-guangzhou'
};

const RENTAL_KEYS = [
  'oneYearFull',
  'twoYearFull',
  'threeYearFull',
  'oneYearMove',
  'twoYearMove',
  'threeYearMove'
];
const CATEGORY_OPTIONS = ['整机服务器', 'CPU', '网卡', '模组', '机头', 'SSD固态', '企业机械盘', '内存', 'GPU', '其他'];
const LEGACY_CATEGORIES = ['整机', '硬盘'];
const MINI_CATEGORIES = [...CATEGORY_OPTIONS, ...LEGACY_CATEGORIES];
const MINI_CONDITIONS = ['新', '全新', '拆机', '二手', '未标注'];
const MINI_SCOPES = ['mine', 'company', 'shared'];
const MACHINE_CONFIG_KEYS = MINI_MACHINE_CONFIG_KEYS;
const EXPORT_HEADER = ['类型', '品类', '成色', '型号规格', '数量', '售卖价格', '售卖单位', '一年全包', '两年全包', '三年全包', '一年搬迁', '两年搬迁', '三年搬迁', '租赁单位', 'GPU', 'CPU', '内存', '系统盘', '数据盘', '网卡1', '网卡2', '网卡3', '网卡4', '更多网卡', 'Raid卡', '电源', 'PCIE交换芯片', '货主信息', '联系人', '电话', '客户标签', '紧急', '备注', '范围', '共享给', '发布时间', '发布人', '是否删除', '删除人'];
const PRICE_UNITS = {
  CNY_TEN_THOUSAND: 'cny_10k',
  CNY_TEN_THOUSAND_PIECE: 'cny_10k_piece',
  CNY_TEN_THOUSAND_STRIP: 'cny_10k_strip',
  USD: 'usd',
  USD_PIECE: 'usd_piece',
  USD_STRIP: 'usd_strip'
};
const PRICE_UNIT_OPTIONS = [
  { label: '万元/台', value: PRICE_UNITS.CNY_TEN_THOUSAND, saleLabel: '万元/台', rentalLabel: '万/月/台' },
  { label: '万元/片', value: PRICE_UNITS.CNY_TEN_THOUSAND_PIECE, saleLabel: '万元/片', rentalLabel: '万/月/片' },
  { label: '万元/条', value: PRICE_UNITS.CNY_TEN_THOUSAND_STRIP, saleLabel: '万元/条', rentalLabel: '万/月/条' },
  { label: '美金/台', value: PRICE_UNITS.USD, saleLabel: '美金/台', rentalLabel: '美金/月/台' },
  { label: '美金/片', value: PRICE_UNITS.USD_PIECE, saleLabel: '美金/片', rentalLabel: '美金/月/片' },
  { label: '美金/条', value: PRICE_UNITS.USD_STRIP, saleLabel: '美金/条', rentalLabel: '美金/月/条' }
];

fs.mkdirSync(PUBLIC, { recursive: true });
fs.mkdirSync(path.join(MINI_UPLOAD_DIR, 'images'), { recursive: true });
fs.mkdirSync(path.join(MINI_UPLOAD_DIR, 'videos'), { recursive: true });
fs.mkdirSync(path.join(WEB_UPLOAD_DIR, 'images'), { recursive: true });
fs.mkdirSync(path.join(WEB_UPLOAD_DIR, 'videos'), { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ items: [], logs: [] }, null, 2));
migrateDb();

function now() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }
function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}
function loginFailureKey(name, phone, req) { return `${normalizeName(name)}:${normalizePhone(phone)}:${requestIp(req)}`; }
function loginLocked(key) {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (entry.lockedUntil && entry.lockedUntil > nowMs()) return true;
  if (entry.lockedUntil && entry.lockedUntil <= nowMs()) loginFailures.delete(key);
  return false;
}
function recordLoginFailure(key) {
  const entry = loginFailures.get(key) || { count: 0, lockedUntil: 0, lastAt: 0 };
  entry.count += 1;
  entry.lastAt = nowMs();
  if (entry.count >= LOGIN_MAX_FAILS) entry.lockedUntil = nowMs() + LOGIN_LOCK_MS;
  loginFailures.set(key, entry);
}
function clearLoginFailure(key) { loginFailures.delete(key); }
function smsConfigReady() {
  return SMS_CONFIG.secretId && SMS_CONFIG.secretKey && SMS_CONFIG.SdkAppId && SMS_CONFIG.TemplateId && SMS_CONFIG.SignName;
}
function createSmsClient() {
  const tencentcloud = require('tencentcloud-sdk-nodejs');
  const SmsClient = tencentcloud.sms.v20210111.Client;
  return new SmsClient({
    credential: { secretId: SMS_CONFIG.secretId, secretKey: SMS_CONFIG.secretKey },
    region: SMS_CONFIG.region,
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } }
  });
}
function smsCodeSecret() {
  return process.env.JUZHEN_SMS_CODE_SECRET || MINI_SESSION_SECRET;
}
function smsKey(name, phone) { return `${normalizeName(name)}:${normalizePhone(phone)}`; }
function hashSmsCode(code, name, phone, nonce) {
  return crypto.createHmac('sha256', smsCodeSecret()).update(`${smsKey(name, phone)}:${code}:${nonce}`).digest('hex');
}
function cleanupSmsCodes() {
  const cutoff = nowMs() - 24 * 60 * 60 * 1000;
  for (const [key, list] of smsCodes.entries()) {
    const kept = list.filter(row => row.createdAtMs > cutoff);
    if (kept.length) smsCodes.set(key, kept);
    else smsCodes.delete(key);
  }
}
function smsRows() {
  cleanupSmsCodes();
  return Array.from(smsCodes.values()).flat();
}
function countSmsRows(predicate) {
  return smsRows().filter(predicate).length;
}
function findLoginUser(db, name, phone) {
  const key = smsKey(name, phone);
  return (db.users || []).find(u => (u.loginKey || `${u.name}:${u.phone}`) === key);
}
async function createLoginSession(user, db, res, options = {}) {
  const role = user.role || 'member';
  user.lastLoginAt = now();
  await saveDb(db, { broadcast: false });
  const sid = crypto.randomBytes(24).toString('hex');
  const mustChangePassword = options.authMethod === 'sms' ? false : Boolean(user.mustChangePassword);
  registerSession(user, sid, {
    role,
    name: user.name,
    phone: user.phone,
    group: user.group || '',
    userId: user.id,
    displayName: displayUser(user),
    mustChangePassword,
    authMethod: options.authMethod || 'password',
    createdAt: nowMs(),
    expiresAt: nowMs() + SESSION_MAX_AGE_MS
  });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'set-cookie': `jz_session=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`,
    'cache-control': 'no-store'
  });
  return res.end(JSON.stringify({ ok: true, role, name: user.name, phone: user.phone, group: user.group || '', displayName: displayUser(user), mustChangePassword }));
}
function passwordStrongEnough(password, user = {}) {
  const value = String(password || '');
  if (value.length < 10) return false;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
  const lower = value.toLowerCase();
  if (['123456', '12345678', 'password', 'qwerty'].includes(lower)) return false;
  if (user.phone && lower.includes(String(user.phone).slice(-6))) return false;
  if (user.name && lower.includes(String(user.name).toLowerCase())) return false;
  return true;
}
function registerSession(user, sid, session) {
  sessions.set(sid, session);
  const key = user.id || `${user.name}:${user.phone}`;
  if (!userSessions.has(key)) userSessions.set(key, new Set());
  userSessions.get(key).add(sid);
}
function deleteSession(sid) {
  const session = sessions.get(sid);
  sessions.delete(sid);
  if (session) {
    const key = session.userId || `${session.name}:${session.phone}`;
    const set = userSessions.get(key);
    if (set) { set.delete(sid); if (!set.size) userSessions.delete(key); }
  }
}
function clearUserSessions(user, keepSid = '') {
  const key = user.id || `${user.name}:${user.phone}`;
  const set = userSessions.get(key);
  if (!set) return;
  for (const sid of Array.from(set)) {
    if (sid !== keepSid) deleteSession(sid);
  }
}
function requireRecentPassword(req, res, s, body = {}) {
  if (!isAdminRole(s)) return true;
  if (s.lastSensitiveAuthAt && nowMs() - s.lastSensitiveAuthAt <= SENSITIVE_ACTION_MAX_AGE_MS) return true;
  const password = text(body.adminPassword || body.confirmPassword || '', 80);
  if (!password) { send(res, 403, { error: '管理员敏感操作需要再次输入当前密码', needReauth: true }); return false; }
  const db = readDb();
  const user = db.users.find(u => u.id === s.userId || (u.name === s.name && u.phone === s.phone));
  if (!user || !verifyPassword(user, password)) { send(res, 403, { error: '管理员密码验证失败', needReauth: true }); return false; }
  s.lastSensitiveAuthAt = nowMs();
  return true;
}
function readDb() { migrateDb(); return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const bak = file + '.bak';
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, content);
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, bak); } catch (error) { console.warn('db backup failed', error.message); }
  }
  fs.renameSync(tmp, file);
}
let dbWriteQueue = Promise.resolve();
function saveDb(db, options = {}) {
  dbWriteQueue = dbWriteQueue.catch(() => {}).then(() => {
    writeJsonAtomic(DB_FILE, db);
    if (options.broadcast !== false) broadcast();
  });
  return dbWriteQueue;
}
function text(value, limit = 300) { return String(value || '').trim().slice(0, limit); }
function normalizeName(value) { return text(value, 40); }
function normalizePhone(value) { return String(value || '').replace(/\D/g, '').slice(0, 20); }
function displayUser(user) {
  const roleLabel = user.role === 'superadmin' ? '超级管理员' : user.role === 'admin' ? '管理员' : '';
  const groupLabel = user.group === '管理员' || user.group === '超级管理员' ? '' : user.group;
  return [groupLabel, user.name, user.phone, roleLabel].filter(Boolean).join(' · ');
}
function isTemporaryAccount(user = {}) {
  return String(user.name || '').startsWith('临时');
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}
function verifyPassword(user, password) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const next = hashPassword(password, user.passwordSalt).hash;
  return crypto.timingSafeEqual(Buffer.from(next, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function loadSeedConfig(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Invalid seed config ${file}: ${error.message}`);
  }
}
function normalizeGroupApprovers(input = {}) {
  return Object.fromEntries(Object.entries(input).map(([group, approver]) => [
    text(group, 40),
    normalizeName(approver)
  ]).filter(([group, approver]) => group && approver));
}
function normalizeSeedUsers(users = []) {
  return users.map(user => ({
    name: normalizeName(user.name),
    phone: normalizePhone(user.phone),
    group: text(user.group, 40),
    role: ['member', 'admin', 'superadmin'].includes(user.role) ? user.role : 'member'
  })).filter(user => user.name && user.phone);
}
function parseSuperAdmins() {
  const raw = process.env.JUZHEN_SUPER_ADMINS || '';
  const parsed = raw.split(',').map(pair => {
    const [name, password] = pair.split(':');
    return { name: normalizeName(name), password: text(password, 80) };
  }).filter(a => a.name && a.password).slice(0, 5);
  if (!parsed.length) throw new Error('Missing required environment variable: JUZHEN_SUPER_ADMINS');
  return parsed;
}
function matchSuperAdmin(name, password) {
  return SUPER_ADMIN_ACCOUNTS.find(a => a.name === normalizeName(name) && a.password === text(password, 80));
}
function isAdminRole(s) { return s?.role === 'admin' || s?.role === 'superadmin'; }
function isSuperAdmin(s) { return s?.role === 'superadmin'; }
function approvalGroupForSession(s) {
  if (!s) return '';
  return Object.entries(GROUP_APPROVERS).find(([, approver]) => approver === s.name)?.[0] || '';
}
function truthy(value) {
  return ['true', '1', 'yes', 'y', '是', '紧急'].includes(String(value ?? '').trim().toLowerCase()) || value === true;
}
function normalizeScopeValue(value, fallback = 'company') {
  const raw = String(value || '').trim();
  const map = {
    mine: 'mine',
    company: 'company',
    shared: 'shared',
    我的货源: 'mine',
    我的需求: 'mine',
    公司货源: 'company',
    公司需求: 'company',
    共享给我: 'shared',
    共享: 'shared'
  };
  return map[raw] || fallback;
}
function normalizeSideValue(value, fallback = 'supply') {
  const raw = String(value || '').trim().toLowerCase();
  if (['demand', '需求', '求购', '求租'].includes(raw)) return 'demand';
  if (['supply', '货源', '供应', '出售', '售卖', '租赁'].includes(raw)) return 'supply';
  return fallback;
}
function pricingSummary(pricing, side = 'supply') {
  const saleLabel = side === 'demand' ? '求购' : '售卖';
  const rentalLabelText = side === 'demand' ? '求租' : '租赁';
  const parts = [];
  if (pricing.saleEnabled && pricing.salePrice) {
    parts.push(`${saleLabel} ${pricing.salePrice} ${pricing.saleUnit || '万元/台'}`);
  }
  const rentalParts = RENTAL_KEYS
    .filter(key => pricing.rentalQuotes[key])
    .map(key => `${rentalLabel(key)} ${rentalUnitText(pricing.rentalQuotes[key], pricing.rentalUnit)}`);
  if (pricing.rentalEnabled && rentalParts.length) {
    parts.push(`${rentalLabelText} ${rentalParts.join(' / ')}`);
  }
  if (!parts.length && pricing.legacyPrice) parts.push(pricing.legacyPrice);
  return parts.join('；');
}
function rentalLabel(key) {
  return {
    oneYearFull: '一年全包',
    twoYearFull: '两年全包',
    threeYearFull: '三年全包',
    oneYearMove: '一年搬迁',
    twoYearMove: '两年搬迁',
    threeYearMove: '三年搬迁'
  }[key] || key;
}
function normalizePriceUnit(value, fallback = PRICE_UNITS.CNY_TEN_THOUSAND) {
  const raw = text(value, 40).toLowerCase();
  if (!raw) return fallback;
  if (PRICE_UNIT_OPTIONS.some(option => option.value === raw)) return raw;
  const hasUsd = /usd|美元|美金/.test(raw);
  const hasPiece = /piece|片/.test(raw);
  const hasStrip = /strip|条/.test(raw);
  if (hasUsd && hasPiece) return PRICE_UNITS.USD_PIECE;
  if (hasUsd && hasStrip) return PRICE_UNITS.USD_STRIP;
  if (hasUsd) return PRICE_UNITS.USD;
  if (hasPiece) return PRICE_UNITS.CNY_TEN_THOUSAND_PIECE;
  if (hasStrip) return PRICE_UNITS.CNY_TEN_THOUSAND_STRIP;
  return fallback;
}
function getPriceUnitOption(unit) {
  const normalized = normalizePriceUnit(unit);
  return PRICE_UNIT_OPTIONS.find(option => option.value === normalized) || PRICE_UNIT_OPTIONS[0];
}
function getPriceUnitLabel(unit, mode = 'sale') {
  const option = getPriceUnitOption(unit);
  return mode === 'rental' ? option.rentalLabel : option.saleLabel;
}
function rentalUnitText(value, unit = '万/月/台') {
  const raw = text(value, 60);
  if (!raw) return '';
  if (/\/(台|片|条)$/.test(raw) || /(台|片|条)$/.test(raw)) return raw;
  if (/美金\/月$/.test(raw) || /美元\/月$/.test(raw) || /万\/月$/.test(raw)) return raw + '/' + getPriceUnitLabel(unit, 'rental').split('/').pop();
  return `${raw}${getPriceUnitLabel(unit, 'rental')}`;
}
function plainPriceValue(value) {
  return text(value, 120)
    .replace(/^(售卖价格|出售价格|求购价格|租赁价格|求租价格|售卖|出售|求购|租赁|求租|报价|价格|[一二两三123]年(?:全包|搬迁))\s*/g, '')
    .replace(/[需收]\s*/g, '')
    .replace(/\s*(万元|万|美金|美元)\/?(月)?\/?(台|片|条)?\s*$/g, '')
    .trim();
}
function isCompositePriceText(value) {
  return /[；;]|租赁|求租|[一二两三123]年(?:全包|搬迁)/.test(text(value, 120));
}
function priceLabelAliases(label) {
  const map = {
    '一年全包': ['一年全包', '1年全包'],
    '两年全包': ['两年全包', '二年全包', '2年全包'],
    '三年全包': ['三年全包', '3年全包'],
    '一年搬迁': ['一年搬迁', '1年搬迁'],
    '两年搬迁': ['两年搬迁', '二年搬迁', '2年搬迁'],
    '三年搬迁': ['三年搬迁', '3年搬迁']
  };
  return map[label] || [label];
}
function extractLegacyPrice(summary, label) {
  const source = text(summary, 300).replace(/[；;]/g, ' / ');
  if (!source) return '';
  const labels = ['售卖', '出售', '求购', '租赁', '求租', '一年全包', '两年全包', '三年全包', '一年搬迁', '两年搬迁', '三年搬迁'].flatMap(priceLabelAliases);
  const labelOptions = priceLabelAliases(label);
  const alternatives = labels.filter(x => !labelOptions.includes(x)).join('|');
  const re = new RegExp(`(?:${labelOptions.join('|')})\\s*([^；;/]+?)(?=\\s*(?:${alternatives})|\\s*/|$)`);
  const match = source.match(re);
  return match ? plainPriceValue(match[1]) : '';
}
function normalizePricing(input = {}, fallbackPrice = '') {
  const src = input && typeof input === 'object' ? input : {};
  const legacyPrice = text(src.legacyPrice || fallbackPrice, 120);
  const composite = [src.salePrice, legacyPrice].find(isCompositePriceText) || '';
  const rentalQuotes = Object.fromEntries(RENTAL_KEYS.map(key => [key, plainPriceValue(src.rentalQuotes?.[key]) || extractLegacyPrice(composite, rentalLabel(key))]));
  const salePrice = (isCompositePriceText(src.salePrice) ? '' : plainPriceValue(src.salePrice))
    || extractLegacyPrice(composite, '售卖')
    || extractLegacyPrice(composite, '出售')
    || extractLegacyPrice(composite, '求购');
  const saleUnit = normalizePriceUnit(src.saleUnit || src.priceUnit || src.unit);
  const rentalUnit = normalizePriceUnit(src.rentalUnit || saleUnit, saleUnit);
  let saleEnabled = truthy(src.saleEnabled);
  let rentalEnabled = truthy(src.rentalEnabled);
  if (salePrice) saleEnabled = true;
  if (Object.values(rentalQuotes).some(Boolean)) rentalEnabled = true;
  if (!saleEnabled && !rentalEnabled && legacyPrice) {
    saleEnabled = true;
  }
  return {
    saleEnabled,
    salePrice: salePrice || (!src.rentalEnabled && legacyPrice ? legacyPrice : ''),
    saleUnit: getPriceUnitLabel(saleUnit, 'sale'),
    saleUnitValue: saleUnit,
    rentalEnabled,
    rentalQuotes,
    rentalUnit: getPriceUnitLabel(rentalUnit, 'rental'),
    rentalUnitValue: rentalUnit,
    legacyPrice
  };
}
function isMachineCategory(category) {
  return ['整机', '整机服务器'].includes(category);
}
function detectCategory(value) {
  const raw = String(value || '');
  if (/SSD|固态/i.test(raw)) return 'SSD固态';
  if (/机械盘|企业盘/.test(raw)) return '企业机械盘';
  if (/CPU|至强|EPYC/i.test(raw)) return 'CPU';
  if (/网卡/.test(raw)) return '网卡';
  if (/模组|光模块/.test(raw)) return '模组';
  if (/机头|准系统/.test(raw)) return '机头';
  if (/GPU|显卡/i.test(raw)) return 'GPU';
  if (/内存|DDR|RDIMM|内存条/i.test(raw)) return '内存';
  if (/整机|服务器/.test(raw)) return '整机服务器';
  return '';
}
function normalizeCategory(value, fallback = '其他') {
  const raw = text(value, 40);
  if (MINI_CATEGORIES.includes(raw)) return raw;
  return detectCategory(raw) || fallback;
}
function normalizeCondition(value, fallback = '未标注') {
  return normalizeEnum(text(value, 40), MINI_CONDITIONS, fallback);
}
function migrateDb() {
  let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!Array.isArray(db.items)) db.items = [];
  if (!Array.isArray(db.logs)) db.logs = [];
  if (!Array.isArray(db.users)) db.users = [];
  if (!db.meta || typeof db.meta !== 'object' || Array.isArray(db.meta)) db.meta = {};
  let changed = false;
  db.users = db.users.map(user => {
    const next = { ...user };
    if (!next.phone) {
      next.phone = normalizePhone(next.name);
      if (next.phone) changed = true;
    } else {
      const phone = normalizePhone(next.phone);
      if (phone !== next.phone) { next.phone = phone; changed = true; }
    }
    if (!next.loginKey && next.name && next.phone) {
      next.loginKey = `${next.name}:${next.phone}`;
      changed = true;
    }
    if (!next.group) { next.group = ''; changed = true; }
    if (!next.status) { next.status = 'approved'; changed = true; }
    if (!next.role) { next.role = 'member'; changed = true; }
    if (!next.createdAt) { next.createdAt = now(); changed = true; }
    return next;
  });
  const beforeRemovedUsers = db.users.length;
  db.users = db.users.filter(user => !REMOVED_SEEDED_LOGIN_KEYS.has(user.loginKey || `${user.name}:${user.phone}`));
  if (db.users.length !== beforeRemovedUsers) changed = true;
  SEEDED_USERS.forEach(account => {
    const loginKey = `${account.name}:${account.phone}`;
    const existing = db.users.find(user => (user.loginKey || `${user.name}:${user.phone}`) === loginKey);
    const tempAccount = isTemporaryAccount(account);
    const initialPassword = tempAccount ? TEMP_ACCOUNT_PASSWORD : INITIAL_USER_PASSWORD;
    if (!existing) {
      const password = hashPassword(initialPassword);
      db.users.push({
        id: crypto.randomUUID(),
        name: account.name,
        phone: account.phone,
        group: account.group,
        loginKey,
        role: account.role,
        status: 'approved',
        passwordHash: password.hash,
        passwordSalt: password.salt,
        mustChangePassword: !tempAccount,
        seedVersion: USER_SEED_VERSION,
        tempPasswordVersion: tempAccount ? TEMP_ACCOUNT_PASSWORD_VERSION : '',
        createdAt: now(),
        approvedAt: now(),
        approvedBy: 'system'
      });
      changed = true;
    } else {
      const patch = {};
      if (existing.loginKey !== loginKey) patch.loginKey = loginKey;
      if (!existing.passwordHash || !existing.passwordSalt) {
        const password = hashPassword(initialPassword);
        patch.passwordHash = password.hash;
        patch.passwordSalt = password.salt;
        patch.mustChangePassword = !tempAccount;
        patch.seedVersion = USER_SEED_VERSION;
      }
      if (tempAccount && existing.tempPasswordVersion !== TEMP_ACCOUNT_PASSWORD_VERSION) {
        const password = hashPassword(TEMP_ACCOUNT_PASSWORD);
        patch.passwordHash = password.hash;
        patch.passwordSalt = password.salt;
        patch.mustChangePassword = false;
        patch.tempPasswordVersion = TEMP_ACCOUNT_PASSWORD_VERSION;
      }
      if (typeof existing.mustChangePassword !== 'boolean') patch.mustChangePassword = !tempAccount;
      if (!existing.approvedAt) patch.approvedAt = now();
      if (!existing.approvedBy) patch.approvedBy = 'system';
      if (Object.keys(patch).length) {
        Object.assign(existing, patch);
        changed = true;
      }
    }
  });
  db.items = db.items.map(item => {
    const next = { ...item };
    if (!next.id) { next.id = crypto.randomUUID(); changed = true; }
    if (!next.ownerName) { next.ownerName = next.person || '历史数据'; changed = true; }
    if (!next.scope) { next.scope = 'company'; changed = true; }
    if (!Array.isArray(next.sharedTo)) { next.sharedTo = []; changed = true; }
    if (next.side === 'supply' && next.scope === 'shared' && next.sharedTo.length === 0) { next.scope = 'company'; changed = true; }
    if (typeof next.deleted !== 'boolean') { next.deleted = false; changed = true; }
    const media = normalizeMedia(next.media, { image: next.image || '', video: next.video || '' });
    if (JSON.stringify(media) !== JSON.stringify(next.media || [])) { next.media = media; changed = true; }
    const firstImage = media.find(item => item.type === 'image')?.url || '';
    const firstVideo = media.find(item => item.type === 'video')?.url || '';
    if ((next.image || '') !== firstImage) { next.image = firstImage; changed = true; }
    if ((next.video || '') !== firstVideo) { next.video = firstVideo; changed = true; }
    if (!next.machineConfig) { next.machineConfig = {}; changed = true; }
    if (next.side === 'supply' && !next.cargoOwnerInfo && next.ownerInfo) {
      next.cargoOwnerInfo = text(next.ownerInfo, 1000);
      changed = true;
    }
    if (next.side === 'supply' && next.cargoOwnerInfo && !next.cargoOwnerVisibility) {
      next.cargoOwnerVisibility = 'owner_group_admin';
      changed = true;
    }
    if (!next.createdAt) { next.createdAt = now(); changed = true; }
    if (!next.updatedAt) { next.updatedAt = next.createdAt; changed = true; }
    const business = withBusinessDefaults(next);
    if (JSON.stringify(business) !== JSON.stringify(next)) {
      Object.assign(next, business);
      changed = true;
    }
    if (next.completionReviewStatus === 'pending') {
      const at = next.completionRequestedAt || next.updatedAt || now();
      next.completionReviewStatus = 'approved';
      next.completionAutoApproved = true;
      next.completionReviewedAt = next.completionReviewedAt || at;
      next.completionReviewedBy = next.completionReviewedBy || next.completionRequestedBy || 'system';
      next.completionReviewedByName = next.completionReviewedByName || next.completionRequestedByName || next.ownerName || 'system';
      if (next.offlineReviewStatus !== 'pending') {
        next.status = next.side === 'demand' ? 'done' : 'sold';
        if (next.side === 'demand') next.doneAt = next.doneAt || at;
        else {
          next.soldAt = next.soldAt || at;
          next.sellerId = next.sellerId || next.completionRequestedBy || '';
          next.sellerName = next.sellerName || next.completionRequestedByName || '';
        }
      }
      changed = true;
    }
    const pricing = normalizePricing(next.pricing, next.price);
    if (JSON.stringify(pricing) !== JSON.stringify(next.pricing || {})) {
      next.pricing = pricing;
      changed = true;
    }
    const summary = pricingSummary(pricing, next.side);
    if ((next.price || '') !== summary) {
      next.price = summary;
      changed = true;
    }
    return next;
  });
  db.logs = db.logs.map(log => {
    const next = { ...log };
    const before = compactLogPayload(next.before);
    const after = compactLogPayload(next.after);
    if (JSON.stringify(before) !== JSON.stringify(next.before || null)) {
      next.before = before;
      changed = true;
    }
    if (JSON.stringify(after) !== JSON.stringify(next.after || null)) {
      next.after = after;
      changed = true;
    }
    return next;
  });
  if (changed) writeJsonAtomic(DB_FILE, db);
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').filter(Boolean).map(v => {
    const i = v.indexOf('=');
    return [decodeURIComponent(v.slice(0, i).trim()), decodeURIComponent(v.slice(i + 1).trim())];
  }));
}
function getSession(req) {
  const sid = parseCookies(req).jz_session;
  const s = sid ? sessions.get(sid) : null;
  if (!s) return null;
  if (s.expiresAt && s.expiresAt < nowMs()) { deleteSession(sid); return null; }
  const user = syncSessionUser(sid, s);
  if (!user) return null;
  s.lastSeenAt = nowMs();
  return s;
}
function syncSessionUser(sid, s) {
  if (!s?.userId && !(s?.name && s?.phone)) return s;
  const db = readDb();
  const user = (db.users || []).find(row => row.id === s.userId || (row.name === s.name && row.phone === s.phone));
  if (!user || user.status !== 'approved') {
    deleteSession(sid);
    return null;
  }
  s.userId = user.id;
  s.name = user.name;
  s.phone = user.phone || '';
  s.group = user.group || '';
  s.role = user.role || 'member';
  s.displayName = displayUser(user);
  s.mustChangePassword = s.authMethod === 'sms' ? false : Boolean(user.mustChangePassword);
  return s;
}
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function sendRedirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}
function htmlPage(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f4f7fb; color: #172839; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; }
    main { width: min(560px, 100%); padding: 28px; border: 1px solid #d9e3ea; border-radius: 8px; background: #fff; box-shadow: 0 14px 34px rgba(35, 61, 84, .08); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0 0 14px; color: #657789; line-height: 1.7; }
    code { display: block; padding: 10px; border-radius: 8px; background: #f0f5f8; color: #24455d; overflow-x: auto; }
    a { color: #1c6fb8; font-weight: 800; text-decoration: none; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}
function adminDashboardAccessPage(message = '请从主站右上角“管理看板”入口进入') {
  return htmlPage('管理看板访问受限', `
    <h1>管理看板访问受限</h1>
    <p>${message}</p>
    <p>模拟主站入口：</p>
    <code>http://127.0.0.1:${PORT}</code>
  `);
}
function sendCsv(res, filename, rows) {
  const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\n') + '\n';
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  });
  res.end(csv);
}
function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function requireAuth(req, res) {
  const s = getSession(req);
  if (!s) {
    send(res, 401, { error: 'unauthorized' });
    return null;
  }
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (s.mustChangePassword && !['/api/me', '/api/change-password', '/api/logout'].includes(pathname)) {
    send(res, 423, { error: '首次登录请先修改密码', mustChangePassword: true });
    return null;
  }
  return s;
}
function adminDashboardCookieSecure(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return !(host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1');
}
function requestHostPort(req) {
  const raw = String(req.headers.host || '');
  const port = raw.includes(':') ? Number(raw.split(':').pop()) : 0;
  return Number.isFinite(port) ? port : 0;
}
function isAdminDashboardRequest(req) {
  return isAdminDashboardHost(req.headers.host, ADMIN_DASHBOARD_HOSTS)
    || (ADMIN_DASHBOARD_PORT > 0 && ADMIN_DASHBOARD_PORT !== PORT && requestHostPort(req) === ADMIN_DASHBOARD_PORT);
}
function adminDashboardCookie(sid, req, maxAgeSeconds = 86400) {
  return [
    `jz_admin_session=${sid}`,
    'HttpOnly',
    adminDashboardCookieSecure(req) ? 'Secure' : '',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`
  ].filter(Boolean).join('; ');
}
function createAdminDashboardSession(session) {
  const sid = crypto.randomBytes(24).toString('hex');
  adminDashboardSessions.set(sid, {
    ...session,
    createdAt: nowMs(),
    expiresAt: nowMs() + ADMIN_DASHBOARD_SESSION_MAX_AGE_MS
  });
  return sid;
}
function getAdminDashboardSession(req) {
  const sid = parseCookies(req).jz_admin_session;
  const session = sid ? adminDashboardSessions.get(sid) : null;
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < nowMs()) {
    adminDashboardSessions.delete(sid);
    return null;
  }
  return session;
}
function requireAdminDashboardSession(req, res) {
  const session = getAdminDashboardSession(req);
  if (!canEnterAdminDashboard(session)) {
    return send(res, 403, adminDashboardAccessPage(), 'text/html; charset=utf-8');
  }
  return session;
}
function timingSafeTextEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function base64UrlDecode(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}
function verifyMiniSessionToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signature] = parts;
  const expected = crypto.createHmac('sha256', MINI_SESSION_SECRET).update(`${headerPart}.${payloadPart}`).digest('base64url');
  if (!timingSafeTextEqual(signature, expected)) return null;
  let payload;
  try { payload = JSON.parse(base64UrlDecode(payloadPart)); } catch (e) { return null; }
  if (!payload || payload.typ !== 'mini-session') return null;
  if (!payload.exp || Number(payload.exp) * 1000 <= nowMs()) return null;
  return payload;
}
function miniSessionActor(db, payload) {
  if (!payload) return null;
  const phone = normalizePhone(payload.phone || '');
  const loginKey = text(payload.loginKey || '', 120) || (payload.name && phone ? `${normalizeName(payload.name)}:${phone}` : '');
  const user = (db.users || []).find(row => {
    const rowLoginKey = row.loginKey || `${row.name}:${row.phone}`;
    return row.id === payload.sub || (loginKey && rowLoginKey === loginKey) || (!loginKey && row.phone === phone);
  });
  if (!user || user.status !== 'approved') return null;
  return {
    id: user.id || user.loginKey || `${user.name}:${user.phone}`,
    userId: user.id || user.loginKey || `${user.name}:${user.phone}`,
    name: normalizeName(user.name),
    phone: user.phone || '',
    group: user.group || user.department || '',
    role: user.role || 'member',
    miniSession: true,
    openid: payload.openid || ''
  };
}
function miniUserProfile(user = {}) {
  return {
    id: user.id || user.loginKey || `${user.name}:${user.phone}`,
    name: normalizeName(user.name),
    phone: user.phone || '',
    group: user.group || user.department || '',
    department: user.department || user.group || '',
    role: user.role || 'member',
    roleLabel: user.role === 'superadmin' ? '超级管理员' : user.role === 'admin' ? '管理员' : '业务人员',
    approvalStatus: user.status || 'approved',
    status: user.status || 'approved',
    displayName: displayUser(user)
  };
}
function legacyMiniTokenValid(req) {
  return timingSafeTextEqual(req.headers['x-juzhen-token'] || '', MINI_PROGRAM_TOKEN);
}
function requireMiniToken(req, res, url) {
  if (!ALLOW_LEGACY_MINI_TOKEN) {
    send(res, 401, { error: 'mini session required' });
    return false;
  }
  if (!legacyMiniTokenValid(req)) {
    send(res, 401, { error: 'mini token invalid' });
    return false;
  }
  return true;
}
function requireMiniAuth(req, res, url, db, options = {}) {
  const header = String(req.headers.authorization || '');
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const actor = miniSessionActor(db, verifyMiniSessionToken(token));
  if (actor) return { actor, legacy: false };
  if (!options.allowLegacy || !ALLOW_LEGACY_MINI_TOKEN || !legacyMiniTokenValid(req)) {
    send(res, 401, { error: 'mini session required' });
    return null;
  }
  return { actor: null, legacy: true };
}
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    function fail(error) {
      if (done) return;
      done = true;
      try { req.destroy(); } catch (e) {}
      reject(error);
    }
    req.on('data', chunk => {
      if (done) return;
      buf += chunk;
      if (buf.length > 60 * 1024 * 1024) fail(new Error('payload too large'));
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', fail);
  });
}
function splitNames(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/[，,\s]+/).map(s => s.trim()).filter(Boolean);
}
function canSee(item, s, includeDeleted = false) {
  if (item.deleted && !includeDeleted) return false;
  if ((item.status === 'offline' || item.offlineReviewStatus === 'approved') && !includeDeleted) return false;
  if (isAdminRole(s)) return true;
  if (item.deleted) return false;
  return true;
}
function canManage(item, s) { return isAdminRole(s) || item.ownerName === s.name; }
function cargoOwnerVisibilityForActor(s) {
  return isAdminRole(s) ? 'admins' : 'owner_group_admin';
}
function canSeeCargoOwnerInfo(item, s) {
  if (!item || item.side !== 'supply') return false;
  if (isSuperAdmin(s)) return true;
  if (item.cargoOwnerVisibility === 'admins') return s?.role === 'admin';
  if (item.ownerName === s.name) return true;
  const ownerGroup = item.ownerGroup || '';
  const adminGroup = s?.role === 'admin' ? (approvalGroupForSession(s) || s.group || '') : '';
  return Boolean(ownerGroup && adminGroup && ownerGroup === adminGroup);
}
function publicItem(item, s) {
  const output = { ...withBusinessDefaults(item), cargoOwnerInfoVisible: canSeeCargoOwnerInfo(item, s) };
  if (!output.cargoOwnerInfoVisible) {
    delete output.cargoOwnerInfo;
    delete output.ownerInfo;
  } else {
    output.ownerInfo = output.cargoOwnerInfo || output.ownerInfo || '';
  }
  return output;
}
function duplicateCreateKey(item) {
  return [
    item.side,
    item.category,
    item.condition,
    item.title,
    item.quantity,
    item.price,
    item.person,
    item.phone,
    item.ownerName,
    item.scope
  ].map(value => String(value || '').trim()).join('|');
}
function findRecentDuplicateItem(items, item, seconds = 300) {
  const key = duplicateCreateKey(item);
  const createdAt = Date.parse(item.createdAt || now());
  return (items || []).find(row => {
    if (!row || row.deleted || row.id === item.id) return false;
    if (duplicateCreateKey(row) !== key) return false;
    const rowTime = Date.parse(row.createdAt || row.updatedAt || '');
    return Number.isFinite(rowTime) && Math.abs(createdAt - rowTime) <= seconds * 1000;
  });
}
function defaultBusinessStatus(side) {
  return side === 'demand' ? 'pending' : 'on_sale';
}
function normalizeBusinessStatus(side, status) {
  const allowed = side === 'demand'
    ? ['pending', 'following', 'done', 'offline']
    : ['on_sale', 'following', 'sold', 'offline'];
  return allowed.includes(status) ? status : defaultBusinessStatus(side);
}
function withBusinessDefaults(item = {}) {
  const side = item.side === 'demand' ? 'demand' : 'supply';
  return {
    ...item,
    status: normalizeBusinessStatus(side, item.status),
    followOwnerId: item.followOwnerId || '',
    followOwnerName: item.followOwnerName || '',
    sellerId: item.sellerId || '',
    sellerName: item.sellerName || '',
    soldAt: item.soldAt || '',
    doneAt: item.doneAt || '',
    offlineReviewStatus: item.offlineReviewStatus || '',
    offlineReason: item.offlineReason || '',
    offlineRequestedAt: item.offlineRequestedAt || '',
    offlineRequestedBy: item.offlineRequestedBy || '',
    offlineRequestedByName: item.offlineRequestedByName || '',
    offlineReviewedAt: item.offlineReviewedAt || '',
    offlineReviewedBy: item.offlineReviewedBy || '',
    offlineReviewedByName: item.offlineReviewedByName || '',
    completionReviewStatus: item.completionReviewStatus || '',
    completionReason: item.completionReason || '',
    completionRequestedAt: item.completionRequestedAt || '',
    completionRequestedBy: item.completionRequestedBy || '',
    completionRequestedByName: item.completionRequestedByName || '',
    completionReviewedAt: item.completionReviewedAt || '',
    completionReviewedBy: item.completionReviewedBy || '',
    completionReviewedByName: item.completionReviewedByName || '',
    reviewGroup: item.reviewGroup || item.ownerGroup || ''
  };
}
function isCompletionStatus(item = {}) {
  const side = item.side === 'demand' ? 'demand' : 'supply';
  return side === 'demand' ? item.status === 'done' : item.status === 'sold';
}
function isOfflineStatus(item = {}) {
  return item.deleted === true || item.status === 'offline' || item.offlineReviewStatus === 'approved';
}
function isOfflinePending(item = {}) {
  return item.offlineReviewStatus === 'pending';
}
function assertEditableBusinessItem(item = {}) {
  const current = withBusinessDefaults(item);
  if (isOfflinePending(current)) {
    const err = new Error('该条目已有下架申请待审核，请等待管理员处理');
    err.status = 409;
    throw err;
  }
  if (isCompletionStatus(current)) {
    const err = new Error('该条目已完成，不能重复操作');
    err.status = 409;
    throw err;
  }
  if (isOfflineStatus(current)) {
    const err = new Error('该条目已下架，不能重复操作');
    err.status = 409;
    throw err;
  }
}
function assertStatusTransitionAllowed(item = {}, normalizedAction = '') {
  const current = withBusinessDefaults(item);
  const approvalActions = ['offline_approve', 'offline_reject'];
  if (approvalActions.includes(normalizedAction)) {
    if (current.offlineReviewStatus !== 'pending') {
      const err = new Error('该下架申请已处理，请刷新列表');
      err.status = 409;
      throw err;
    }
    return;
  }
  if (normalizedAction === 'complete') {
    if (isOfflinePending(current)) {
      const err = new Error('该条目已有下架申请待审核，请等待管理员处理');
      err.status = 409;
      throw err;
    }
    if (isCompletionStatus(current)) {
      const err = new Error('该条目已完成，不能重复操作');
      err.status = 409;
      throw err;
    }
    if (isOfflineStatus(current)) {
      const err = new Error('该条目已下架，不能重复操作');
      err.status = 409;
      throw err;
    }
  } else if (normalizedAction === 'offline') {
    if (isOfflinePending(current)) {
      const err = new Error('该条目已有下架申请待审核，请等待管理员处理');
      err.status = 409;
      throw err;
    }
    if (isCompletionStatus(current)) {
      const err = new Error('该条目已完成，不能提交下架申请');
      err.status = 409;
      throw err;
    }
    if (isOfflineStatus(current)) {
      const err = new Error('该条目已下架，不能重复操作');
      err.status = 409;
      throw err;
    }
  } else if (['follow'].includes(normalizedAction)) {
    assertEditableBusinessItem(current);
  }
}
function assertOfflineApprovalPermission(item = {}, normalizedAction = '', actor = {}) {
  if (!['offline_approve', 'offline_reject'].includes(normalizedAction)) return;
  const operatorRole = text(actor.role || '', 40);
  const isAdminActor = ['admin', 'superadmin', 'manager'].includes(operatorRole);
  const targetGroup = item.reviewGroup || item.ownerGroup || '';
  if (!isAdminActor || (operatorRole !== 'superadmin' && targetGroup && actor.group !== targetGroup)) {
    const err = new Error('只能审核自己负责分组的信息');
    err.status = 403;
    throw err;
  }
}
function applyStatusAction(item, body = {}, actor = {}) {
  const action = text(body.action, 40);
  const operatorId = text(actor.userId || actor.id || '', 80);
  const operatorName = normalizeName(actor.name || '系统');
  const reviewerId = operatorId;
  const reviewerName = operatorName;
  const reviewGroup = text(actor.group || item.ownerGroup || '', 80);
  const reason = text(body.reason || '', 1000);
  const next = withBusinessDefaults(item);
  const at = now();
  const normalizedAction = normalizeStatusAction(action);
  assertStatusTransitionAllowed(next, normalizedAction);
  assertOfflineApprovalPermission(next, normalizedAction, actor);
  const operatorRole = text(actor.role || '', 40);
  const autoApproveOffline = AUTO_APPROVE_OFFLINE_REASONS.has(reason);
  const isAdminActorForStatus = ['admin', 'superadmin', 'manager'].includes(operatorRole);
  if (['complete', 'offline'].includes(normalizedAction) && !isAdminActorForStatus) {
    const ownsByName = next.ownerName && next.ownerName === operatorName;
    const ownsByPhone = next.phone && actor.phone && next.phone === actor.phone;
    if (!ownsByName && !ownsByPhone) {
      const err = new Error('只能操作自己发布的信息');
      err.status = 403;
      throw err;
    }
  }
  const directOffline = autoApproveOffline || isAdminActorForStatus;
  if (normalizedAction === 'follow') {
    const existingFollower = next.followOwnerId || next.followOwnerName || '';
    const isSameFollower = (next.followOwnerId && next.followOwnerId === operatorId)
      || (next.followOwnerName && next.followOwnerName === operatorName);
    if (next.status === 'following' && existingFollower && !isSameFollower) {
      const err = new Error(`该条目已由${next.followOwnerName || '其他用户'}跟进，不能重复跟进`);
      err.status = 409;
      throw err;
    }
    next.status = 'following';
    next.followOwnerId = operatorId;
    next.followOwnerName = operatorName;
  } else if (normalizedAction === 'cancel_follow') {
    const isOwnFollow = (next.followOwnerId && next.followOwnerId === operatorId)
      || (next.followOwnerName && next.followOwnerName === operatorName);
    if (next.status !== 'following') {
      const err = new Error('该条目不在跟进中');
      err.status = 409;
      throw err;
    }
    if (!isOwnFollow) {
      const err = new Error('只能由当前跟进人取消跟进');
      err.status = 403;
      throw err;
    }
    next.status = next.side === 'demand' ? 'pending' : 'on_sale';
    next.followOwnerId = '';
    next.followOwnerName = '';
    next.followCancelPending = true;
  } else if (normalizedAction === 'complete') {
    next.status = next.side === 'demand' ? 'done' : 'sold';
    next.completionReviewStatus = 'approved';
    next.completionAutoApproved = true;
    next.completionReason = reason;
    next.completionRequestedAt = at;
    next.completionRequestedBy = operatorId;
    next.completionRequestedByName = operatorName;
    next.completionReviewedAt = at;
    next.completionReviewedBy = operatorId;
    next.completionReviewedByName = operatorName;
    if (next.side === 'demand') {
      next.doneAt = at;
    } else {
      next.sellerId = operatorId;
      next.sellerName = operatorName;
      next.soldAt = at;
    }
    next.reviewGroup = reviewGroup;
  } else if (normalizedAction === 'offline') {
    if (!reason) {
      const err = new Error('请填写下架原因');
      err.status = 400;
      throw err;
    }
    next.offlineReason = reason;
    if (directOffline) {
      next.status = 'offline';
      next.offlineReviewStatus = 'approved';
      next.offlineRequestedAt = at;
      next.offlineRequestedBy = operatorId;
      next.offlineRequestedByName = operatorName;
      next.offlineReviewedAt = at;
      next.offlineReviewedBy = operatorId;
      next.offlineReviewedByName = operatorName;
      next.offlineAutoApproved = autoApproveOffline;
      next.deleted = true;
      next.deletedAt = at;
      next.deletedBy = operatorName;
    } else {
      next.offlineReviewStatus = 'pending';
      next.offlineRequestedAt = at;
      next.offlineRequestedBy = operatorId;
      next.offlineRequestedByName = operatorName;
      next.offlineReviewedAt = '';
      next.offlineReviewedBy = '';
      next.offlineReviewedByName = '';
      next.offlineAutoApproved = false;
      next.deleted = false;
      next.deletedAt = '';
      next.deletedBy = '';
      next.reviewGroup = reviewGroup;
    }
  } else if (normalizedAction === 'offline_approve') {
    next.status = 'offline';
    next.offlineReviewStatus = 'approved';
    next.offlineReviewedAt = body.offlineReviewedAt || at;
    next.offlineReviewedBy = reviewerId;
    next.offlineReviewedByName = reviewerName;
    next.deleted = true;
    next.deletedAt = body.deletedAt || at;
    next.deletedBy = reviewerName;
  } else if (normalizedAction === 'offline_reject') {
    next.offlineReviewStatus = 'rejected';
    next.offlineReviewedAt = body.offlineReviewedAt || at;
    next.offlineReviewedBy = reviewerId;
    next.offlineReviewedByName = reviewerName;
    if (reason) next.offlineReason = reason;
  } else {
    const err = new Error('未知状态操作');
    err.status = 400;
    throw err;
  }
  next.updatedAt = at;
  next.updatedBy = operatorName;
  return next;
}
function rejectWebApprovalAction(body = {}) {
  const action = text(body.action, 40);
  const normalized = normalizeStatusAction(action);
  if (['offline_approve', 'offline_reject'].includes(normalized)) {
    return '审批操作必须在小程序端完成';
  }
  if (normalized === 'offline' && body.direct === true) {
    return '网页端只能提交下架申请，审批必须在小程序端完成';
  }
  return '';
}
function publicLog(log, s) {
  return {
    ...log,
    before: log.before ? publicItem(log.before, s) : null,
    after: log.after ? publicItem(log.after, s) : null
  };
}
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone || '',
    group: user.group || '',
    displayName: displayUser(user),
    role: user.role,
    status: user.status,
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt,
    approvedAt: user.approvedAt || '',
    approvedBy: user.approvedBy || '',
    rejectedAt: user.rejectedAt || '',
    rejectedBy: user.rejectedBy || '',
    lastLogin: user.lastLoginAt || ''
  };
}
function requireSuperAdminSession(req, res) {
  const s = requireAuth(req, res);
  if (!s) return null;
  if (!isSuperAdmin(s)) {
    send(res, 403, { error: '需要超级管理员权限' });
    return null;
  }
  return s;
}
function cleanUserRole(value, fallback = 'member') {
  return normalizeEnum(value, ['member', 'admin', 'superadmin'], fallback);
}
function activeSuperAdminCount(users = []) {
  return users.filter(user => user.role === 'superadmin' && user.status === 'approved').length;
}
function assertCanChangeUser(db, target, next = {}) {
  if (!target) return '账号不存在';
  const targetWillStopBeingActiveSuperAdmin = target.role === 'superadmin'
    && target.status === 'approved'
    && ((next.role && next.role !== 'superadmin') || (next.status && next.status !== 'approved'));
  if (targetWillStopBeingActiveSuperAdmin && activeSuperAdminCount(db.users) <= 1) {
    return '至少需要保留一个正常状态的超级管理员';
  }
  return '';
}
function uniqueUserLoginKey(name, phone) {
  return `${normalizeName(name)}:${normalizePhone(phone)}`;
}
function generateInitialPassword() {
  return `Rlc${crypto.randomBytes(5).toString('hex')}8`;
}
function machineConfig(input = {}, preserved = {}) {
  return mergeMiniMachineConfig(preserved, input);
}
function mediaExt(mime, type) {
  const imageTypes = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
  const videoTypes = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
  return type === 'video' ? videoTypes[mime] : imageTypes[mime];
}
function persistMediaUrl(url, type = 'image') {
  const value = String(url || '').trim();
  if (!value.startsWith('data:')) return value;
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return value;
  const mime = match[1];
  const kind = type === 'video' || mime.startsWith('video/') ? 'video' : 'image';
  const ext = mediaExt(mime, kind);
  if (!ext) return value;
  let buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch (e) {
    return value;
  }
  if (!buffer.length) return value;
  const dir = path.join(WEB_UPLOAD_DIR, kind === 'video' ? 'videos' : 'images');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return '/' + path.relative(PUBLIC, filePath).replace(/\\/g, '/');
}
function normalizeMedia(input = [], fallback = {}) {
  const rows = [];
  if (Array.isArray(input)) {
    input.forEach(item => {
      if (!item) return;
      if (typeof item === 'string') {
        rows.push({ type: item.startsWith('data:video') ? 'video' : 'image', url: item });
        return;
      }
      rows.push({
        type: item.type === 'video' ? 'video' : 'image',
        url: item.url || item.src || item.data || ''
      });
    });
  }
  if (fallback.image) rows.push({ type: 'image', url: fallback.image });
  if (fallback.video) rows.push({ type: 'video', url: fallback.video });
  const seen = new Set();
  return rows
    .map(item => ({ type: item.type === 'video' ? 'video' : 'image', url: String(item.url || '').trim() }))
    .filter(item => item.url)
    .filter(item => {
      const key = `${item.type}:${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(item => {
      const type = item.type === 'video' ? 'video' : 'image';
      return { type, url: text(persistMediaUrl(item.url, type), 50000000) };
    })
    .filter(item => item.url)
    .slice(0, 3);
}
function parseMachineConfigText(value = '') {
  const result = {};
  const labelMap = [
    { key: 'gpu', re: /^(gpu|显卡|gpu卡)\s*[:：]\s*(.+)$/i },
    { key: 'cpu', re: /^(cpu|处理器)\s*[:：]\s*(.+)$/i },
    { key: 'memory', re: /^(内存|memory|mem)\s*[:：]\s*(.+)$/i },
    { key: 'systemDisk', re: /^(系统盘|系统硬盘|sys(?:tem)?\s*disk)\s*[:：]\s*(.+)$/i },
    { key: 'dataDisk', re: /^(数据盘|硬盘|存储|data\s*disk|disk|ssd|hdd)\s*[:：]\s*(.+)$/i },
    { key: 'nic1', re: /^(网卡1|网卡|nic|nic1)\s*[:：]\s*(.+)$/i },
    { key: 'nic2', re: /^(网卡2|nic2)\s*[:：]\s*(.+)$/i },
    { key: 'nic3', re: /^(网卡3|nic3)\s*[:：]\s*(.+)$/i },
    { key: 'nic4', re: /^(网卡4|nic4)\s*[:：]\s*(.+)$/i },
    { key: 'extraNics', re: /^(更多网卡|其他网卡|多网卡|extra\s*nics?)\s*[:：]\s*(.+)$/i },
    { key: 'raid', re: /^(raid|raid卡|阵列卡)\s*[:：]\s*(.+)$/i },
    { key: 'psu', re: /^(psu|电源|power)\s*[:：]\s*(.+)$/i },
    { key: 'pcieSwitch', re: /^(pcie交换芯片|pcie\s*switch|pcie芯片|交换芯片)\s*[:：]\s*(.+)$/i }
  ];
  String(value || '')
    .replace(/&#x0*a;/gi, '\n')
    .replace(/&#10;/g, '\n')
    .split(/\r?\n|；|;/)
    .map(line => line.trim())
    .filter(Boolean)
    .forEach(line => {
      for (const item of labelMap) {
        const match = line.match(item.re);
        if (match && !result[item.key]) {
          result[item.key] = text(match[2], 200);
          break;
        }
      }
    });
  return result;
}
function exportPricing(item) {
  const pricing = item.pricing || {};
  const rental = pricing.rentalQuotes || {};
  const summary = pricingSummary(pricing, item.side) || item.price || '';
  const directSalePrice = isCompositePriceText(pricing.salePrice) ? '' : plainPriceValue(pricing.salePrice);
  const salePrice = directSalePrice || extractLegacyPrice(summary, item.side === 'demand' ? '求购' : '售卖') || extractLegacyPrice(summary, '出售');
  return {
    salePrice,
    saleUnit: pricing.saleUnit || '万元/台',
    rentalUnit: pricing.rentalUnit || '万/月/台',
    rentalQuotes: {
      oneYearFull: plainPriceValue(rental.oneYearFull) || extractLegacyPrice(summary, '一年全包'),
      twoYearFull: plainPriceValue(rental.twoYearFull) || extractLegacyPrice(summary, '两年全包'),
      threeYearFull: plainPriceValue(rental.threeYearFull) || extractLegacyPrice(summary, '三年全包'),
      oneYearMove: plainPriceValue(rental.oneYearMove) || extractLegacyPrice(summary, '一年搬迁'),
      twoYearMove: plainPriceValue(rental.twoYearMove) || extractLegacyPrice(summary, '两年搬迁'),
      threeYearMove: plainPriceValue(rental.threeYearMove) || extractLegacyPrice(summary, '三年搬迁')
    }
  };
}
function exportRow(sideText, item, s) {
  const x = publicItem(item, s);
  const c = x.machineConfig || {};
  const pricing = exportPricing(x);
  const rental = pricing.rentalQuotes;
  return [
    sideText, x.category, x.condition, x.title, x.quantity,
    pricing.salePrice || '', pricing.saleUnit,
    rental.oneYearFull || '', rental.twoYearFull || '', rental.threeYearFull || '',
    rental.oneYearMove || '', rental.twoYearMove || '', rental.threeYearMove || '',
    pricing.rentalUnit,
    c.gpu || '', c.cpu || '', c.memory || '', c.systemDisk || '', c.dataDisk || '',
    c.nic1 || '', c.nic2 || '', c.nic3 || '', c.nic4 || '', c.extraNics || '', c.raid || '', c.psu || '', c.pcieSwitch || '',
    x.cargoOwnerInfo || '', x.person || '', x.phone || '', x.customer || '老客户', x.urgent ? '是' : '否',
    x.note || '', x.scope || 'company', (x.sharedTo || []).join(','), x.createdAt || '', x.ownerName || '',
    x.deleted ? '是' : '否', x.deletedBy || ''
  ];
}
function templateRows() {
  return [
    EXPORT_HEADER,
    ['货源', '整机服务器', '全新', 'B300 服务器', '1 台', '5000', '万元/台', '3.2', '', '', '', '', '', '万/月/台', 'RTX 5090 风扇*8', 'Intel 6530*2', '64G DDR5-4800 *16', '480G SATA*2', '3.84T *1', '25G双光口*1', '100G双光口*1', 'IB 200G*1', 'OCP 25G*1', '', '', '2700W*4', '', '示例货主/来源方/内部联系人', '上传人姓名', '上传人电话', '老客户', '否', '也可在备注整段粘贴配置参数', 'company', '', '', '', '', '']
  ];
}
function stripMachineConfigText(value = '') {
  const configLine = /^(gpu|显卡|gpu卡|cpu|处理器|内存|memory|mem|系统盘|系统硬盘|sys(?:tem)?\s*disk|数据盘|硬盘|存储|data\s*disk|disk|ssd|hdd|网卡1|网卡|nic|nic1|网卡2|nic2|网卡3|nic3|网卡4|nic4|更多网卡|其他网卡|多网卡|extra\s*nics?|raid|raid卡|阵列卡|psu|电源|power|pcie交换芯片|pcie\s*switch|pcie芯片|交换芯片)\s*[:：]\s*.+$/i;
  return String(value || '')
    .replace(/&#x0*a;/gi, '\n')
    .replace(/&#10;/g, '\n')
    .split(/\r?\n/)
    .filter(line => !configLine.test(line.trim()))
    .join('\n')
    .trim();
}
function cleanItem(input, s, old = {}) {
  const pick = key => text(input[key] ?? old[key] ?? '', ['image', 'video'].includes(key) ? 50000000 : 300);
  const category = normalizeCategory(pick('category'), detectCategory([pick('title'), pick('note')].join(' ')) || '其他');
  const scope = ['mine', 'company', 'shared'].includes(input.scope) ? input.scope : (old.scope || 'company');
  const pricing = normalizePricing(input.pricing || old.pricing || {}, pick('price'));
  const rawNote = pick('note');
  const note = isMachineCategory(category) ? stripMachineConfigText(rawNote) : rawNote;
  const parsedConfig = parseMachineConfigText(rawNote);
  const side = input.side === 'demand' ? 'demand' : (old.side || 'supply');
  const rawMachineConfig = { ...parsedConfig, ...(input.machineConfig || old.machineConfig || {}) };
  const canEditCargoOwner = !old.id || canSeeCargoOwnerInfo(old, s);
  const cargoOwnerInfo = side === 'supply'
    ? (canEditCargoOwner ? text(input.cargoOwnerInfo ?? input.ownerInfo ?? old.cargoOwnerInfo ?? old.ownerInfo ?? '', 1000) : (old.cargoOwnerInfo || old.ownerInfo || ''))
    : '';
  const cargoOwnerVisibility = side === 'supply' && cargoOwnerInfo
    ? text(input.cargoOwnerVisibility || old.cargoOwnerVisibility || cargoOwnerVisibilityForActor(s), 40)
    : '';
  const ownerInfoFields = synchronizedOwnerInfo(cargoOwnerInfo);
  const media = normalizeMedia(input.media ?? old.media, {
    image: input.image ?? old.image ?? '',
    video: input.video ?? old.video ?? ''
  });
  return {
    ...old,
    id: old.id || input.id || crypto.randomUUID(),
    side,
    category,
    condition: pick('condition') || '未标注',
    title: pick('title') || '未命名条目',
    quantity: pick('quantity'),
    price: pricingSummary(pricing, side),
    pricing,
    person: pick('person'),
    phone: pick('phone'),
    customer: input.customer === '新客户' ? '新客户' : '老客户',
    urgent: truthy(input.urgent ?? old.urgent ?? ''),
    note,
    image: media.find(item => item.type === 'image')?.url || pick('image'),
    video: media.find(item => item.type === 'video')?.url || pick('video'),
    media,
    ...ownerInfoFields,
    cargoOwnerVisibility,
    scope,
    sharedTo: scope === 'shared' ? splitNames(input.sharedTo ?? old.sharedTo) : [],
    ownerName: old.ownerName || s.name,
    ownerRole: old.ownerRole || s.role,
    ownerGroup: old.ownerGroup || s.group || '',
    status: normalizeBusinessStatus(side, old.status),
    followOwnerId: old.followOwnerId || '',
    followOwnerName: old.followOwnerName || '',
    sellerId: old.sellerId || '',
    sellerName: old.sellerName || '',
    soldAt: old.soldAt || '',
    doneAt: old.doneAt || '',
    offlineReviewStatus: old.offlineReviewStatus || '',
    offlineReason: old.offlineReason || '',
    offlineRequestedAt: old.offlineRequestedAt || '',
    offlineRequestedBy: old.offlineRequestedBy || '',
    offlineRequestedByName: old.offlineRequestedByName || '',
    offlineReviewedAt: old.offlineReviewedAt || '',
    offlineReviewedBy: old.offlineReviewedBy || '',
    offlineReviewedByName: old.offlineReviewedByName || '',
    completionReviewStatus: old.completionReviewStatus || '',
    completionReason: old.completionReason || '',
    completionRequestedAt: old.completionRequestedAt || '',
    completionRequestedBy: old.completionRequestedBy || '',
    completionRequestedByName: old.completionRequestedByName || '',
    completionReviewedAt: old.completionReviewedAt || '',
    completionReviewedBy: old.completionReviewedBy || '',
    completionReviewedByName: old.completionReviewedByName || '',
    reviewGroup: old.reviewGroup || old.ownerGroup || s.group || '',
    machineConfig: side === 'supply'
      ? machineConfig(rawMachineConfig, old.machineConfig || {})
      : (isMachineCategory(category) ? machineConfig(rawMachineConfig, old.machineConfig || {}) : {}),
    deleted: Boolean(old.deleted),
    createdAt: old.createdAt || now(),
    updatedAt: now(),
    updatedBy: s.name
  };
}
function addLog(db, action, s, before, after, note = '') {
  db.logs.unshift({
    id: crypto.randomUUID(),
    action,
    actorName: s.name,
    actorRole: s.role,
    itemId: after?.id || before?.id || '',
    at: now(),
    before: compactLogPayload(before),
    after: compactLogPayload(after),
    note
  });
  db.logs = db.logs.slice(0, 2000);
}
function compactLogPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload || null;
  if (!('media' in payload) && !('image' in payload) && !('video' in payload)) return payload;
  const next = { ...payload };
  const media = normalizeMedia(next.media, { image: next.image || '', video: next.video || '' });
  next.media = media;
  next.image = media.find(item => item.type === 'image')?.url || '';
  next.video = media.find(item => item.type === 'video')?.url || '';
  return next;
}
function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const src = String(textValue || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some(v => String(v).trim())) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some(v => String(v).trim())) rows.push(row);
  return rows;
}
function importRows(side, rows, s) {
  if (!rows.length) return [];
  const aliases = {
    category: ['category', '品类', '产品类型'],
    condition: ['condition', '成色', '状态'],
    title: ['title', '型号规格', '型号', '规格', '标题'],
    quantity: ['quantity', '数量'],
    price: ['price', '价格', '报价'],
    person: ['person', '联系人', '提交人'],
    phone: ['phone', '电话', '微信', '联系方式'],
    cargoOwnerInfo: ['cargoOwnerInfo', 'ownerInfo', '货主信息', '货主', '来源方', '内部货主', '真实货主', '货主联系方式'],
    cargoOwnerName: ['货主姓名', '货主联系人', '来源联系人'],
    cargoOwnerPhone: ['货主电话', '货主微信', '来源电话', '来源微信'],
    customer: ['customer', '客户标签', '客户类型'],
    urgent: ['urgent', '紧急', '是否紧急'],
    note: ['note', '备注'],
    scope: ['scope', '范围', '可见范围'],
    sharedTo: ['sharedTo', '共享给', '共享人'],
    gpu: ['gpu', 'GPU', '显卡'],
    cpu: ['cpu', 'CPU', '处理器'],
    memory: ['memory', '内存'],
    systemDisk: ['systemDisk', '系统盘'],
    dataDisk: ['dataDisk', '数据盘', '硬盘'],
    nic1: ['nic1', '网卡1', '网卡'],
    nic2: ['nic2', '网卡2'],
    nic3: ['nic3', '网卡3'],
    nic4: ['nic4', '网卡4'],
    raid: ['raid', 'Raid卡', 'RAID', '阵列卡'],
    psu: ['psu', 'PSU', '电源']
    ,
    extraNics: ['extraNics', '更多网卡', '其他网卡', '多网卡'],
    pcieSwitch: ['pcieSwitch', 'PCIE交换芯片', 'PCIe交换芯片', 'PCIE芯片', 'PCIe芯片', '交换芯片']
  };
  const pricingAliases = {
    salePrice: ['salePrice', '售卖价格', '出售价格', '求购价格'],
    saleUnit: ['saleUnit', '售卖单位', '出售单位', '求购单位'],
    rentalUnit: ['rentalUnit', '租赁单位', '求租单位'],
    oneYearFull: ['oneYearFull', '一年全包'],
    twoYearFull: ['twoYearFull', '两年全包'],
    threeYearFull: ['threeYearFull', '三年全包'],
    oneYearMove: ['oneYearMove', '一年搬迁'],
    twoYearMove: ['twoYearMove', '两年搬迁'],
    threeYearMove: ['threeYearMove', '三年搬迁']
  };
  const sideAliases = ['side', '类型', '导入类型'];
  const ignoredKeys = new Set(['发布时间', '发布人', '是否删除', '删除人']);
  const configKeys = new Set(MACHINE_CONFIG_KEYS);
  const pricingKeys = new Set(Object.keys(pricingAliases));
  const first = rows[0].map(v => String(v).trim());
  const hasHeader = first.some(h => Object.values(aliases).flat().includes(h) || Object.values(pricingAliases).flat().includes(h) || sideAliases.includes(h));
  const header = hasHeader ? first : ['category', 'condition', 'title', 'quantity', 'price', 'person', 'phone', 'customer', 'urgent', 'note'];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const keyFor = h => {
    if (sideAliases.includes(h)) return 'rowSide';
    if (ignoredKeys.has(h)) return 'ignored';
    return Object.entries(aliases).find(([, names]) => names.includes(h))?.[0]
      || Object.entries(pricingAliases).find(([, names]) => names.includes(h))?.[0]
      || h;
  };
  return dataRows
    .map(cols => {
      const raw = { side, machineConfig: {}, pricing: { rentalQuotes: {} } };
      header.forEach((h, i) => {
        const key = keyFor(String(h).trim());
        const value = cols[i] || '';
        if (key === 'ignored') return;
        if (key === 'rowSide') {
          raw.side = normalizeSideValue(value, side);
          return;
        }
        if (configKeys.has(key)) {
          if (String(value).trim()) raw.machineConfig[key] = value;
        } else if (pricingKeys.has(key)) {
          if (RENTAL_KEYS.includes(key)) raw.pricing.rentalQuotes[key] = value;
          else raw.pricing[key] = value;
        } else {
          raw[key] = value;
        }
      });
      if (raw.side === 'supply') {
        const ownerParts = [
          raw.cargoOwnerInfo,
          raw.cargoOwnerName && `货主：${raw.cargoOwnerName}`,
          raw.cargoOwnerPhone && `联系方式：${raw.cargoOwnerPhone}`,
          !raw.cargoOwnerInfo && !raw.cargoOwnerName && raw.person && `联系人：${raw.person}`,
          !raw.cargoOwnerInfo && !raw.cargoOwnerPhone && raw.phone && `电话/微信：${raw.phone}`
        ].filter(value => String(value || '').trim());
        if (ownerParts.length) {
          raw.cargoOwnerInfo = ownerParts.join('；');
          raw.cargoOwnerVisibility = cargoOwnerVisibilityForActor(s);
          raw.person = s.name || '';
          raw.phone = s.phone || '';
        }
        delete raw.cargoOwnerName;
        delete raw.cargoOwnerPhone;
      }
      raw.scope = normalizeScopeValue(raw.scope, 'company');
      if (Object.values(raw.pricing.rentalQuotes).some(v => String(v || '').trim())) raw.pricing.rentalEnabled = true;
      if (String(raw.pricing.salePrice || '').trim()) raw.pricing.saleEnabled = true;
      if (!raw.pricing.salePrice && !Object.values(raw.pricing.rentalQuotes).some(Boolean)) delete raw.pricing;
      return cleanItem(raw, s);
    })
    .filter(item => item.title && item.title !== '未命名条目');
}
function xmlText(value = '') {
  return String(value)
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
function colIndex(ref = '') {
  const letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return Math.max(n - 1, 0);
}
function unzipEntries(buffer) {
  const entries = {};
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('不是有效的 xlsx 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const fileNameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + fileNameLength).toString('utf8');
    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.slice(dataStart, dataStart + compressedSize);
      entries[name] = method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
    }
    pos += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}
function parseXlsxRows(buffer) {
  const entries = unzipEntries(buffer);
  const sharedXml = entries['xl/sharedStrings.xml'] || '';
  const shared = [];
  sharedXml.replace(/<si[\s\S]*?<\/si>/g, block => {
    shared.push(xmlText((block.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).join('')));
    return block;
  });
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = entries['xl/workbook.xml'] || '';
  const rels = entries['xl/_rels/workbook.xml.rels'] || '';
  const firstSheet = workbook.match(/<sheet\b[^>]*r:id="([^"]+)"/);
  if (firstSheet) {
    const relMatch = rels.match(new RegExp(`<Relationship[^>]*Id="${firstSheet[1]}"[^>]*Target="([^"]+)"`));
    if (relMatch) sheetPath = relMatch[1].startsWith('/') ? relMatch[1].slice(1) : 'xl/' + relMatch[1].replace(/^\/?xl\//, '');
  }
  const sheetXml = entries[sheetPath] || entries['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('xlsx 中没有找到工作表');
  const rows = [];
  sheetXml.replace(/<row\b[^>]*>[\s\S]*?<\/row>/g, rowXml => {
    const row = [];
    rowXml.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (_, attrs, cellXml) => {
      const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || '';
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
      const idx = colIndex(ref);
      let value = '';
      if (type === 'inlineStr') value = xmlText(cellXml);
      else {
        const v = (cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1] || '';
        value = type === 's' ? (shared[Number(v)] || '') : xmlText(v);
      }
      row[idx] = value;
      return '';
    });
    if (row.some(v => String(v || '').trim())) rows.push(row.map(v => v || ''));
    return '';
  });
  return rows;
}
function importItems(side, csv, s) {
  if (hasBrokenEncoding(csv)) {
    const err = new Error('CSV 文件编码识别失败，请重新下载模板后直接上传，或另存为 UTF-8 CSV 后再导入');
    err.code = 'BAD_CSV_ENCODING';
    throw err;
  }
  const rows = parseCsv(csv);
  return importRows(side, rows, s);
}
function hasBrokenEncoding(value) {
  const src = String(value || '');
  const brokenCount = (src.match(/\uFFFD/g) || []).length;
  return brokenCount >= 2;
}
function broadcast() {
  const msg = `data: ${JSON.stringify({ type: 'changed', at: Date.now() })}\n\n`;
  for (const res of clients) res.write(msg);
}
function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
function normalizeScopeWithShared(scopeValue, sharedValue, fallback = 'company', side = 'supply') {
  const scope = normalizeEnum(scopeValue, MINI_SCOPES, fallback);
  const sharedTo = scope === 'shared' ? splitNames(sharedValue) : [];
  return {
    scope: side === 'supply' && scope === 'shared' && !sharedTo.length ? 'company' : scope,
    sharedTo
  };
}
function normalizeMiniItemInput(input = {}, old = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const side = normalizeEnum(src.side || old.side, ['supply', 'demand'], old.side || 'supply');
  const category = normalizeCategory(src.category || old.category, normalizeCategory(old.category, '其他'));
  const condition = normalizeCondition(src.condition || old.condition, old.condition || '未标注');
  const normalizedScope = normalizeScopeWithShared(src.scope || old.scope, src.sharedTo ?? old.sharedTo, old.scope || 'company', side);
  const rentalQuotes = Object.fromEntries(RENTAL_KEYS.map(key => [key, text(src.pricing?.rentalQuotes?.[key] ?? old.pricing?.rentalQuotes?.[key] ?? '', 60)]));
  const mergedMachineConfig = mergeMiniMachineConfig(old.machineConfig || {}, src.machineConfig || {});
  const cargoOwnerInfo = text(src.cargoOwnerInfo ?? src.ownerInfo ?? old.cargoOwnerInfo ?? old.ownerInfo ?? '', 1000);
  const inputMedia = src.mediaFiles ?? src.media ?? old.media;
  return {
    side,
    category,
    condition,
    title: text(src.title ?? old.title ?? '', 300),
    quantity: text(src.quantity ?? old.quantity ?? '', 300),
    pricing: normalizePricing({
      saleEnabled: src.pricing?.saleEnabled ?? old.pricing?.saleEnabled ?? false,
      salePrice: text(src.pricing?.salePrice ?? old.pricing?.salePrice ?? '', 60),
      saleUnit: text(src.pricing?.saleUnit ?? old.pricing?.saleUnit ?? '', 20),
      rentalEnabled: src.pricing?.rentalEnabled ?? old.pricing?.rentalEnabled ?? false,
      rentalQuotes,
      rentalUnit: text(src.pricing?.rentalUnit ?? old.pricing?.rentalUnit ?? '', 20),
      legacyPrice: text(src.pricing?.legacyPrice ?? src.price ?? old.pricing?.legacyPrice ?? old.price ?? '', 120)
    }, src.price ?? old.price ?? ''),
    person: text(src.person ?? old.person ?? '', 300),
    phone: text(src.phone ?? old.phone ?? '', 300),
    customer: ['新客户', '老客户'].includes(src.customer) ? src.customer : (old.customer || '老客户'),
    urgent: truthy(src.urgent ?? old.urgent ?? false),
    note: text(src.note ?? old.note ?? '', 300),
    image: text(src.image ?? old.image ?? '', 50000000),
    video: text(src.video ?? old.video ?? '', 50000000),
    media: normalizeMedia(inputMedia, { image: src.image ?? old.image ?? '', video: src.video ?? old.video ?? '' }),
    cargoOwnerInfo,
    ownerInfo: cargoOwnerInfo,
    scope: normalizedScope.scope,
    sharedTo: normalizedScope.sharedTo,
    ownerName: normalizeName(src.ownerName || old.ownerName || src.person || '微信小程序'),
    machineConfig: side === 'supply'
      ? mergedMachineConfig
      : (isMachineCategory(category) ? machineConfig(mergedMachineConfig, old.machineConfig || {}) : {})
  };
}
function miniActor(input = {}, old = {}, sessionActor = null) {
  if (sessionActor) return sessionActor;
  return { name: normalizeName(old.ownerName || input.ownerName || input.person || '微信小程序'), role: 'mini' };
}
function miniStatusActor(db, input = {}, old = {}, sessionActor = null) {
  if (sessionActor) return sessionActor;
  const phone = text(input.operatorPhone || input.phone || '', 80);
  const byPhone = phone ? (db.users || []).find(user => user.phone === phone) : null;
  if (!byPhone) {
    const err = new Error('未识别当前用户，请重新登录');
    err.status = 401;
    throw err;
  }
  const userId = byPhone.id || byPhone.loginKey || (byPhone.name + ':' + byPhone.phone);
  return {
    id: userId,
    userId,
    name: normalizeName(byPhone.name),
    phone: byPhone.phone || '',
    group: byPhone.group || byPhone.department || old.ownerGroup || '',
    role: byPhone.role || 'member'
  };
}
function miniActorFromQuery(db, url) {
  const phone = text(url.searchParams.get('operatorPhone') || url.searchParams.get('phone') || '', 80);
  if (!phone) return null;
  const user = (db.users || []).find(row => row.phone === phone);
  if (!user) return null;
  return {
    id: user.id || user.loginKey || `${user.name}:${user.phone}`,
    userId: user.id || user.loginKey || `${user.name}:${user.phone}`,
    name: normalizeName(user.name),
    phone: user.phone || '',
    group: user.group || user.department || '',
    role: user.role || 'member'
  };
}
function applyMiniSyncFields(next, body = {}, actor = {}) {
  // 普通 mini PUT 只允许编辑业务字段；状态/审批/跟进字段必须走 /status 状态机。
  return {
    ...next,
    updatedAt: now(),
    updatedBy: actor.name || '微信小程序'
  };
}
function miniItem(item, actor = null) {
  const normalized = withBusinessDefaults(item);
  const media = normalizeMedia(item.media, { image: item.image || '', video: item.video || '' });
  const pricing = normalizePricing(item.pricing || {}, item.price || '');
  const side = item.side === 'demand' ? 'demand' : 'supply';
  const category = normalizeCategory(item.category, '其他');
  const condition = normalizeCondition(item.condition, '未标注');
  const scope = normalizeEnum(item.scope, MINI_SCOPES, 'company');
  const cargoOwnerInfoVisible = actor ? canSeeCargoOwnerInfo(item, actor) : false;
  const priceLabel = side === 'demand'
    ? { sale: '求购', rental: '求租' }
    : { sale: '出售', rental: '租赁' };
  const signMiniMediaUrl = value => appendMiniMediaSignature(value, MINI_MEDIA_SIGNING_SECRET);
  return {
    id: item.id || '',
    side,
    sideText: side === 'demand' ? '需求' : '货源',
    category,
    condition,
    title: item.title || '未命名条目',
    summaryTitle: [category, condition, item.title || '未命名条目'].filter(Boolean).join('-'),
    quantity: item.quantity || '',
    price: pricingSummary(pricing, side),
    pricing,
    priceLabel,
    dualMode: Boolean(pricing.saleEnabled && pricing.rentalEnabled),
    person: item.ownerName || item.person || '',
    phone: '',
    ownerInfo: cargoOwnerInfoVisible ? item.cargoOwnerInfo || item.ownerInfo || '' : '',
    cargoOwnerInfo: cargoOwnerInfoVisible ? item.cargoOwnerInfo || item.ownerInfo || '' : '',
    canViewOwnerInfo: cargoOwnerInfoVisible,
    customer: item.customer === '新客户' ? '新客户' : '老客户',
    urgent: Boolean(item.urgent),
    note: item.note || '',
    image: signMiniMediaUrl(media.find(row => row.type === 'image')?.url || item.image || ''),
    video: signMiniMediaUrl(media.find(row => row.type === 'video')?.url || item.video || ''),
    media: media.map(row => ({ ...row, url: signMiniMediaUrl(row.url) })),
    scope,
    sharedTo: Array.isArray(item.sharedTo) ? item.sharedTo : [],
    ownerName: item.ownerName || '',
    machineConfig: side === 'supply'
      ? machineConfig(item.machineConfig || {})
      : (isMachineCategory(category) ? machineConfig(item.machineConfig || {}) : machineConfig({})),
    createdAt: item.createdAt || '',
    updatedAt: item.updatedAt || item.createdAt || '',
    deleted: Boolean(item.deleted),
    deletedAt: item.deletedAt || '',
    deletedBy: item.deletedBy || '',
    status: normalized.status,
    followOwnerId: normalized.followOwnerId,
    followOwnerName: normalized.followOwnerName,
    sellerId: normalized.sellerId,
    sellerName: normalized.sellerName,
    soldAt: normalized.soldAt,
    doneAt: normalized.doneAt,
    offlineReviewStatus: normalized.offlineReviewStatus,
    offlineReason: normalized.offlineReason,
    offlineRequestedAt: normalized.offlineRequestedAt,
    offlineRequestedBy: normalized.offlineRequestedBy,
    offlineRequestedByName: normalized.offlineRequestedByName,
    offlineReviewedAt: normalized.offlineReviewedAt,
    offlineReviewedBy: normalized.offlineReviewedBy,
    offlineReviewedByName: normalized.offlineReviewedByName,
    completionReviewStatus: normalized.completionReviewStatus,
    completionReason: normalized.completionReason,
    completionRequestedAt: normalized.completionRequestedAt,
    completionRequestedBy: normalized.completionRequestedBy,
    completionRequestedByName: normalized.completionRequestedByName,
    completionReviewedAt: normalized.completionReviewedAt,
    completionReviewedBy: normalized.completionReviewedBy,
    completionReviewedByName: normalized.completionReviewedByName,
    reviewGroup: normalized.reviewGroup
  };
}
function miniBootstrapItem(input = {}) {
  const raw = normalizeMiniItemInput(input);
  const actor = miniActor(raw);
  let item = cleanItem(raw, actor);
  item = applyMiniSyncFields(item, input, actor);
  if (input.createdAt) item.createdAt = text(input.createdAt, 80);
  if (input.updatedAt) item.updatedAt = text(input.updatedAt, 80);
  return item;
}
function publicUrl(req, filePath) {
  const relative = '/' + path.relative(PUBLIC, filePath).replace(/\\/g, '/');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}${relative}` : relative;
}
function servePublicFile(req, res, url) {
  const decoded = decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC, decoded));
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(res, 404, { error: 'not found' });
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm'
  };
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=31536000' });
  fs.createReadStream(filePath).pipe(res);
}
function canServeUploadMedia(req, res, url) {
  const session = getSession(req);
  if (session) {
    if (!requireAuth(req, res)) return false;
    return true;
  }
  if (hasValidMiniMediaSignature(url, MINI_MEDIA_SIGNING_SECRET)) return true;
  send(res, 401, { error: 'unauthorized' });
  return false;
}
function handleAdminDashboardHost(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/entry') {
    const result = adminDashboardTickets.consume(url.searchParams.get('ticket'));
    if (!result.ok || !canEnterAdminDashboard(result.session)) {
      return send(res, 403, adminDashboardAccessPage('入口凭证无效、已过期或已使用，请从主站右上角“管理看板”重新进入。'), 'text/html; charset=utf-8');
    }
    const sid = createAdminDashboardSession(result.session);
    return sendRedirect(res, '/dashboard', {
      'set-cookie': adminDashboardCookie(sid, req)
    });
  }
  if (req.method === 'GET' && url.pathname === '/dashboard') {
    if (!requireAdminDashboardSession(req, res)) return;
    return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'super-admin-usage-dashboard-demo.html'), 'utf8'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/') {
    if (getAdminDashboardSession(req)) return sendRedirect(res, '/dashboard');
    return send(res, 403, adminDashboardAccessPage(), 'text/html; charset=utf-8');
  }
  return send(res, 404, adminDashboardAccessPage('管理看板模拟域名下没有该页面，请从主站入口进入。'), 'text/html; charset=utf-8');
}
async function saveMiniUpload(req, res, url, kind) {
  const db = readDb();
  if (!requireMiniAuth(req, res, url, db, { allowLegacy: true })) return;
  const body = await bodyJson(req);
  const raw = text(body.data || body.base64 || body.file || '', 60000000);
  if (!raw) return send(res, 400, { error: '缺少上传文件 data/base64 字段' });
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  const mime = text(body.mimeType || body.type || (match ? match[1] : ''), 60);
  const base64 = match ? match[2] : raw;
  const ext = mediaExt(mime, kind);
  if (!ext) return send(res, 400, { error: kind === 'image' ? '图片格式仅支持 jpeg/png/webp/gif' : '视频格式仅支持 mp4/mov/webm' });
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (e) {
    return send(res, 400, { error: 'base64 文件内容无效' });
  }
  if (!buffer.length) return send(res, 400, { error: '上传文件为空' });
  const limit = kind === 'image' ? 12 * 1024 * 1024 : 60 * 1024 * 1024;
  if (buffer.length > limit) return send(res, 413, { error: kind === 'image' ? '图片不能超过 12MB' : '视频不能超过 60MB' });
  const dir = path.join(MINI_UPLOAD_DIR, kind === 'image' ? 'images' : 'videos');
  const filePath = path.join(dir, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return send(res, 201, { ok: true, type: kind, url: publicUrl(req, filePath), path: '/' + path.relative(PUBLIC, filePath).replace(/\\/g, '/') });
}

process.on('unhandledRejection', error => console.error('unhandledRejection', error));
process.on('uncaughtException', error => console.error('uncaughtException', error));

const requestHandler = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (isAdminDashboardRequest(req)) {
      return handleAdminDashboardHost(req, res, url);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
      if (isPublicUploadMediaPath(url.pathname)) {
        return servePublicFile(req, res, url);
      }
      if (!canServeUploadMedia(req, res, url)) return;
      return servePublicFile(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/admin-dashboard-entry') {
      const s = requireAuth(req, res);
      if (!s) return;
      if (!canEnterAdminDashboard(s)) return send(res, 403, { error: '只有超级管理员可以进入管理看板' });
      const ticket = adminDashboardTickets.issue(s);
      const origin = dashboardOriginForRequest({
        configuredOrigin: process.env.JUZHEN_ADMIN_DASHBOARD_ORIGIN || '',
        host: req.headers.host || '',
        fallbackPort: PORT
      });
      return sendRedirect(res, `${origin}/entry?ticket=${encodeURIComponent(ticket)}`);
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await bodyJson(req);
      const name = normalizeName(body.name);
      const phone = normalizePhone(body.phone);
      const passwordValue = text(body.password, 80);
      if (!name || !phone) return send(res, 400, { error: '请输入姓名和手机号' });
      if (!passwordValue) return send(res, 400, { error: '请输入密码' });
      const failKey = loginFailureKey(name, phone, req);
      if (loginLocked(failKey)) return send(res, 429, { error: '登录失败次数过多，请 15 分钟后再试' });
      const db = readDb();
      const loginKey = `${name}:${phone}`;
      let user = db.users.find(u => (u.loginKey || `${u.name}:${u.phone}`) === loginKey);
      if (!user) {
        return send(res, 403, { error: '账号不在允许登录名单内，请联系管理员' });
      }
      if (!verifyPassword(user, passwordValue)) { recordLoginFailure(failKey); return send(res, 403, { error: '账号不存在或密码不正确' }); }
      clearLoginFailure(failKey);
      if (user.status !== 'approved') {
        const message = user.status === 'disabled' ? '账号已停用，请联系超级管理员' : '账号不可用，请联系超级管理员';
        return send(res, 403, { error: message, status: user.status });
      }
      return createLoginSession(user, db, res, { authMethod: 'password' });
    }
    if (req.method === 'POST' && url.pathname === '/api/login/sms/send') {
      const body = await bodyJson(req);
      const name = normalizeName(body.name);
      const phone = normalizePhone(body.phone);
      if (!name || !phone) return send(res, 400, { error: '请输入姓名和手机号' });
      if (!/^1[3-9]\d{9}$/.test(phone)) return send(res, 400, { error: '手机号格式不正确' });
      if (!smsConfigReady()) return send(res, 503, { error: '短信服务未配置，请联系管理员' });
      const db = readDb();
      const user = findLoginUser(db, name, phone);
      if (!user || user.status !== 'approved') return send(res, 403, { error: user?.status === 'disabled' ? '账号已停用，请联系超级管理员' : '账号不在允许登录名单内，请联系管理员' });
      const ip = requestIp(req);
      const currentKey = smsKey(name, phone);
      const recentThreshold = nowMs() - SMS_SEND_INTERVAL_SECONDS * 1000;
      const dayThreshold = nowMs() - 24 * 60 * 60 * 1000;
      const recentPhone = countSmsRows(row => row.phone === phone && row.createdAtMs > recentThreshold);
      if (recentPhone) return send(res, 429, { error: '发送太频繁，请稍后再试' });
      if (countSmsRows(row => row.phone === phone && row.createdAtMs > dayThreshold) >= SMS_PHONE_DAILY_LIMIT) return send(res, 429, { error: '该手机号今日验证码次数已达上限' });
      if (countSmsRows(row => row.ip === ip && row.createdAtMs > dayThreshold) >= SMS_IP_DAILY_LIMIT) return send(res, 429, { error: '当前网络今日验证码次数已达上限' });
      const code = crypto.randomInt(100000, 1000000).toString();
      try {
        const smsRes = await createSmsClient().SendSms({
          PhoneNumberSet: ['+86' + phone],
          SmsSdkAppId: SMS_CONFIG.SdkAppId,
          TemplateId: SMS_CONFIG.TemplateId,
          SignName: SMS_CONFIG.SignName,
          TemplateParamSet: [code, String(SMS_CODE_TTL_MINUTES)]
        });
        const status = smsRes.SendStatusSet && smsRes.SendStatusSet[0];
        if (!status || status.Code !== 'Ok') return send(res, 502, { error: (status && status.Message) || '短信发送失败' });
      } catch (error) {
        console.error('web sms send failed', error && error.message ? error.message : error);
        return send(res, 502, { error: '短信发送失败，请稍后再试' });
      }
      const nonce = crypto.randomBytes(16).toString('hex');
      const row = {
        name,
        phone,
        ip,
        codeHash: hashSmsCode(code, name, phone, nonce),
        nonce,
        used: false,
        attempts: 0,
        createdAtMs: nowMs(),
        expiresAtMs: nowMs() + SMS_CODE_TTL_MINUTES * 60 * 1000
      };
      const list = smsCodes.get(currentKey) || [];
      list.push(row);
      smsCodes.set(currentKey, list.slice(-8));
      return send(res, 200, { ok: true, message: '验证码已发送' });
    }
    if (req.method === 'POST' && url.pathname === '/api/login/sms/verify') {
      const body = await bodyJson(req);
      const name = normalizeName(body.name);
      const phone = normalizePhone(body.phone);
      const code = text(body.code, 12);
      if (!name || !phone) return send(res, 400, { error: '请输入姓名和手机号' });
      if (!/^\d{6}$/.test(code)) return send(res, 400, { error: '验证码格式不正确' });
      const failKey = loginFailureKey(name, phone, req);
      if (loginLocked(failKey)) return send(res, 429, { error: '登录失败次数过多，请 15 分钟后再试' });
      const db = readDb();
      const user = findLoginUser(db, name, phone);
      if (!user) { recordLoginFailure(failKey); return send(res, 403, { error: '账号不在允许登录名单内，请联系管理员' }); }
      if (user.status !== 'approved') return send(res, 403, { error: user.status === 'disabled' ? '账号已停用，请联系超级管理员' : '账号不可用，请联系超级管理员', status: user.status });
      const currentKey = smsKey(name, phone);
      cleanupSmsCodes();
      const list = smsCodes.get(currentKey) || [];
      const record = list.slice().reverse().find(row => !row.used && row.expiresAtMs > nowMs());
      if (!record) { recordLoginFailure(failKey); return send(res, 403, { error: '验证码错误或已过期' }); }
      if (record.attempts >= SMS_VERIFY_MAX_ATTEMPTS) { record.used = true; recordLoginFailure(failKey); return send(res, 403, { error: '验证码错误次数过多，请重新获取' }); }
      const expected = hashSmsCode(code, name, phone, record.nonce);
      if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.codeHash, 'hex'))) {
        record.attempts += 1;
        if (record.attempts >= SMS_VERIFY_MAX_ATTEMPTS) record.used = true;
        recordLoginFailure(failKey);
        return send(res, 403, { error: '验证码错误或已过期' });
      }
      record.used = true;
      record.usedAtMs = nowMs();
      clearLoginFailure(failKey);
      return createLoginSession(user, db, res, { authMethod: 'sms' });
    }
    if (req.method === 'POST' && url.pathname === '/api/change-password') {
      const s = requireAuth(req, res);
      if (!s) return;
      const body = await bodyJson(req);
      const oldPassword = text(body.oldPassword, 80);
      const newPassword = text(body.newPassword, 80);
      if (!oldPassword || !newPassword) return send(res, 400, { error: '请输入原密码和新密码' });
      const db = readDb();
      const user = db.users.find(u => u.id === s.userId || (u.name === s.name && u.phone === s.phone));
      if (!user) return send(res, 404, { error: '账号不存在' });
      if (!passwordStrongEnough(newPassword, user)) return send(res, 400, { error: '新密码至少 10 位，且必须包含字母和数字，不能包含手机号后 6 位或姓名' });
      if (newPassword === INITIAL_USER_PASSWORD) return send(res, 400, { error: '新密码不能继续使用初始密码' });
      if (!verifyPassword(user, oldPassword)) return send(res, 403, { error: '原密码不正确' });
      const password = hashPassword(newPassword);
      user.passwordHash = password.hash;
      user.passwordSalt = password.salt;
      user.mustChangePassword = false;
      user.passwordChangedAt = now();
      s.mustChangePassword = false;
      clearUserSessions(user, parseCookies(req).jz_session || '');
      addLog(db, 'change_password', s, null, null, displayUser(user));
      await saveDb(db);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const sid = parseCookies(req).jz_session;
      if (sid) deleteSession(sid);
      res.writeHead(200, {
        'set-cookie': 'jz_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
        'content-type': 'application/json; charset=utf-8'
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const s = getSession(req);
      return send(res, 200, { authenticated: Boolean(s), role: s?.role || '', name: s?.name || '', phone: s?.phone || '', group: s?.group || '', displayName: s?.displayName || (s ? displayUser(s) : ''), mustChangePassword: Boolean(s?.mustChangePassword), approvalGroup: approvalGroupForSession(s) });
    }
    if (req.method === 'GET' && url.pathname === '/api/mock-mode') {
      return send(res, 200, { mockAdminLogin: MOCK_ADMIN_LOGIN_ENABLED });
    }
    if (req.method === 'POST' && url.pathname === '/api/mock-login/superadmin') {
      if (!MOCK_ADMIN_LOGIN_ENABLED) return send(res, 404, { error: 'not found' });
      const db = readDb();
      const user = (db.users || []).find(row => row.role === 'superadmin' && row.status === 'approved');
      const sid = crypto.randomBytes(24).toString('hex');
      const session = {
        role: 'superadmin',
        name: user?.name || '模拟超级管理员',
        phone: user?.phone || '',
        group: user?.group || '模拟环境',
        displayName: user ? displayUser(user) : '模拟超级管理员',
        authMethod: 'mock',
        createdAt: nowMs(),
        expiresAt: nowMs() + SESSION_MAX_AGE_MS
      };
      sessions.set(sid, session);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `jz_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
        'cache-control': 'no-store'
      });
      return res.end(JSON.stringify({ ok: true, role: session.role, name: session.name, displayName: session.displayName, mock: true }));
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      const s = requireSuperAdminSession(req, res);
      if (!s) return;
      const db = readDb();
      const users = (db.users || []).slice().sort((a, b) => {
        const rank = { approved: 0, disabled: 1 };
        return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
      });
      return send(res, 200, { users: users.map(publicUser) });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/users') {
      const s = requireSuperAdminSession(req, res);
      if (!s) return;
      const body = await bodyJson(req);
      if (!requireRecentPassword(req, res, s, body)) return;
      const name = normalizeName(body.name);
      const phone = normalizePhone(body.phone);
      const group = text(body.group, 40);
      const role = cleanUserRole(body.role, 'member');
      if (!name || !phone) return send(res, 400, { error: '请填写姓名和手机号' });
      if (!group) return send(res, 400, { error: '请选择分组' });
      const db = readDb();
      const loginKey = uniqueUserLoginKey(name, phone);
      if ((db.users || []).some(user => (user.loginKey || uniqueUserLoginKey(user.name, user.phone)) === loginKey || user.phone === phone)) {
        return send(res, 409, { error: '该手机号或账号已存在' });
      }
      const initialPassword = generateInitialPassword();
      const password = hashPassword(initialPassword);
      const user = {
        id: crypto.randomUUID(),
        loginKey,
        name,
        phone,
        group,
        role,
        status: 'approved',
        passwordHash: password.hash,
        passwordSalt: password.salt,
        mustChangePassword: true,
        createdAt: now(),
        createdBy: s.name,
        approvedAt: now(),
        approvedBy: s.name
      };
      db.users.push(user);
      addLog(db, 'user_create', s, null, publicUser(user), user.name);
      await saveDb(db);
      return send(res, 201, { user: publicUser(user), initialPassword });
    }
    if (req.method === 'PUT' && /^\/api\/admin\/users\/[^/]+$/.test(url.pathname)) {
      const s = requireSuperAdminSession(req, res);
      if (!s) return;
      const body = await bodyJson(req);
      if (!requireRecentPassword(req, res, s, body)) return;
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const db = readDb();
      const user = db.users.find(u => u.id === id);
      if (!user) return send(res, 404, { error: '账号不存在' });
      const before = publicUser(user);
      const nextRole = 'role' in body ? cleanUserRole(body.role, user.role || 'member') : user.role;
      const nextGroup = 'group' in body ? text(body.group, 40) : user.group;
      if (!nextGroup) return send(res, 400, { error: '请选择分组' });
      if (user.id === s.userId && nextRole !== 'superadmin') return send(res, 400, { error: '不能调整自己的超级管理员权限' });
      const guard = assertCanChangeUser(db, user, { role: nextRole });
      if (guard) return send(res, 400, { error: guard });
      user.role = nextRole;
      user.group = nextGroup;
      user.updatedAt = now();
      user.updatedBy = s.name;
      clearUserSessions(user, parseCookies(req).jz_session || '');
      addLog(db, 'user_update', s, before, publicUser(user), user.name);
      await saveDb(db);
      return send(res, 200, { user: publicUser(user) });
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/disable$/.test(url.pathname)) {
      const s = requireSuperAdminSession(req, res);
      if (!s) return;
      const body = await bodyJson(req);
      if (!requireRecentPassword(req, res, s, body)) return;
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const db = readDb();
      const user = db.users.find(u => u.id === id);
      if (!user) return send(res, 404, { error: '账号不存在' });
      if (user.id === s.userId) return send(res, 400, { error: '不能停用当前登录账号' });
      const before = publicUser(user);
      const guard = assertCanChangeUser(db, user, { status: 'disabled' });
      if (guard) return send(res, 400, { error: guard });
      user.status = 'disabled';
      user.disabledAt = now();
      user.disabledBy = s.name;
      user.updatedAt = now();
      user.updatedBy = s.name;
      clearUserSessions(user);
      addLog(db, 'user_disable', s, before, publicUser(user), user.name);
      await saveDb(db);
      return send(res, 200, { user: publicUser(user) });
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/restore$/.test(url.pathname)) {
      const s = requireSuperAdminSession(req, res);
      if (!s) return;
      const body = await bodyJson(req);
      if (!requireRecentPassword(req, res, s, body)) return;
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const db = readDb();
      const user = db.users.find(u => u.id === id);
      if (!user) return send(res, 404, { error: '账号不存在' });
      const before = publicUser(user);
      user.status = 'approved';
      user.approvedAt = now();
      user.approvedBy = s.name;
      user.rejectedAt = '';
      user.rejectedBy = '';
      user.disabledAt = '';
      user.disabledBy = '';
      user.updatedAt = now();
      user.updatedBy = s.name;
      addLog(db, 'user_restore', s, before, publicUser(user), user.name);
      await saveDb(db);
      return send(res, 200, { user: publicUser(user) });
    }
    if (req.method === 'POST' && /^\/api\/admin\/users\/[^/]+\/reset-password$/.test(url.pathname)) {
      const s = requireSuperAdminSession(req, res);
      if (!s) return;
      const body = await bodyJson(req);
      if (!requireRecentPassword(req, res, s, body)) return;
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const db = readDb();
      const user = db.users.find(u => u.id === id);
      if (!user) return send(res, 404, { error: '账号不存在' });
      const before = publicUser(user);
      const initialPassword = generateInitialPassword();
      const password = hashPassword(initialPassword);
      user.passwordHash = password.hash;
      user.passwordSalt = password.salt;
      user.mustChangePassword = true;
      user.passwordResetAt = now();
      user.passwordResetBy = s.name;
      user.updatedAt = now();
      user.updatedBy = s.name;
      clearUserSessions(user);
      addLog(db, 'user_reset_password', s, before, publicUser(user), user.name);
      await saveDb(db);
      return send(res, 200, { user: publicUser(user), initialPassword });
    }
    if (req.method === 'GET' && url.pathname === '/api/items') {
      const s = requireAuth(req, res);
      if (!s) return;
      const includeDeleted = isAdminRole(s) && url.searchParams.get('includeDeleted') === '1';
      const db = readDb();
      return send(res, 200, { items: db.items.filter(item => canSee(item, s, includeDeleted)).map(item => publicItem(item, s)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/template') {
      const s = requireAuth(req, res);
      if (!s) return;
      return sendCsv(res, '润六尺供需导入模板.csv', templateRows());
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const s = requireAuth(req, res);
      if (!s) return;
      const includeDeleted = isAdminRole(s) && url.searchParams.get('includeDeleted') === '1';
      const side = normalizeEnum(url.searchParams.get('side'), ['supply', 'demand', 'all'], 'all');
      const db = readDb();
      const rows = [EXPORT_HEADER];
      db.items
        .filter(item => canSee(item, s, includeDeleted))
        .filter(item => side === 'all' || item.side === side)
        .forEach(item => rows.push(exportRow(item.side === 'demand' ? '需求' : '货源', item, s)));
      return sendCsv(res, `润六尺供需导出-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const s = requireAuth(req, res);
      if (!s) return;
      if (!isAdminRole(s)) return send(res, 403, { error: '需要管理员权限' });
      const db = readDb();
      return send(res, 200, { logs: db.logs.slice(0, 300).map(log => publicLog(log, s)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/items') {
      const s = requireAuth(req, res);
      if (!s) return;
      const db = readDb();
      const item = cleanItem(await bodyJson(req), s);
      if (item.side === 'supply' && item.scope !== 'company' && !item.cargoOwnerInfo) return send(res, 400, { error: '请补充填写货主信息' });
      const duplicate = findRecentDuplicateItem(db.items, item);
      if (duplicate) return send(res, 200, { ...publicItem(duplicate, s), duplicate: true });
      db.items.unshift(item);
      addLog(db, 'create', s, null, item);
      await saveDb(db);
      return send(res, 201, publicItem(item, s));
    }
    if (req.method === 'POST' && url.pathname === '/api/import') {
      const s = requireAuth(req, res);
      if (!s) return;
      const body = await bodyJson(req);
      let imported;
      try {
        const side = body.side === 'demand' ? 'demand' : 'supply';
        if (body.fileData) {
          const name = text(body.fileName, 200).toLowerCase();
          const base64 = String(body.fileData || '').replace(/^data:[^,]+,/, '');
          const buffer = Buffer.from(base64, 'base64');
          if (name.endsWith('.xlsx')) imported = importRows(side, parseXlsxRows(buffer), s);
          else if (name.endsWith('.xls')) return send(res, 400, { error: '暂不支持老式 .xls，请在 Excel/WPS 中另存为 .xlsx 或 CSV 后再导入' });
          else imported = importItems(side, buffer.toString('utf8'), s);
        } else {
          imported = importItems(side, body.csv || '', s);
        }
      } catch (e) {
        if (e.code === 'BAD_CSV_ENCODING') return send(res, 400, { error: e.message });
        if (/xlsx|工作表|zip|invalid/i.test(e.message || '')) return send(res, 400, { error: 'Excel 文件解析失败，请确认文件是标准 .xlsx，或另存为 CSV 后再导入' });
        throw e;
      }
      if (!imported.length) return send(res, 400, { error: '没有识别到可导入的数据' });
      const db = readDb();
      db.items = imported.concat(db.items);
      imported.forEach(item => addLog(db, 'import', s, null, item));
      await saveDb(db);
      return send(res, 201, { ok: true, count: imported.length });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/items/')) {
      const s = requireAuth(req, res);
      if (!s) return;
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const db = readDb();
      const idx = db.items.findIndex(x => x.id === id);
      if (idx === -1) return send(res, 404, { error: 'not found' });
      const before = { ...db.items[idx] };
      if (!canManage(before, s)) return send(res, 403, { error: '只能修改自己发布的信息' });
      try {
        assertEditableBusinessItem(before);
      } catch (e) {
        return send(res, e.status || 409, { error: e.message || '该条目状态已变化，请刷新后再操作' });
      }
      const next = cleanItem(await bodyJson(req), s, before);
      if (next.side === 'supply' && next.scope !== 'company' && canSeeCargoOwnerInfo(before, s) && !next.cargoOwnerInfo) return send(res, 400, { error: '请补充填写货主信息' });
      db.items[idx] = next;
      addLog(db, 'update', s, before, next);
      await saveDb(db);
      return send(res, 200, publicItem(next, s));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/status') && url.pathname.startsWith('/api/items/')) {
      const s = requireAuth(req, res);
      if (!s) return;
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const db = readDb();
      const idx = db.items.findIndex(x => x.id === id && !x.deleted);
      if (idx === -1) {
        const processed = db.items.find(x => x.id === id);
        if (processed) return send(res, 409, { error: '该下架申请已处理，请刷新列表' });
        return send(res, 404, { error: 'not found' });
      }
      const before = { ...db.items[idx] };
      if (!canManage(before, s)) return send(res, 403, { error: '只能操作自己发布的信息' });
      try {
        const body = await bodyJson(req);
        const approvalError = rejectWebApprovalAction(body);
        if (approvalError) return send(res, 403, { error: approvalError });
        db.items[idx] = applyStatusAction(before, body, s);
      } catch (e) {
        return send(res, e.status || 400, { error: e.message || '状态操作失败' });
      }
      addLog(db, 'status', s, before, db.items[idx]);
      await saveDb(db);
      return send(res, 200, publicItem(db.items[idx], s));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/restore') && url.pathname.startsWith('/api/items/')) {
      const s = requireAuth(req, res);
      if (!s) return;
      if (!isAdminRole(s)) return send(res, 403, { error: '需要管理员权限' });
      const actionBody = await bodyJson(req);
      if (!requireRecentPassword(req, res, s, actionBody)) return;
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const db = readDb();
      const idx = db.items.findIndex(x => x.id === id);
      if (idx === -1) return send(res, 404, { error: 'not found' });
      const before = { ...db.items[idx] };
      db.items[idx] = { ...db.items[idx], deleted: false, deletedAt: '', deletedBy: '', updatedAt: now(), updatedBy: s.name };
      addLog(db, 'restore', s, before, db.items[idx]);
      await saveDb(db);
      return send(res, 200, publicItem(db.items[idx], s));
    }
    if (req.method === 'DELETE' && url.pathname.endsWith('/permanent') && url.pathname.startsWith('/api/items/')) {
      const s = requireAuth(req, res);
      if (!s) return;
      if (!isAdminRole(s)) return send(res, 403, { error: '需要管理员权限' });
      const actionBody = await bodyJson(req);
      if (!requireRecentPassword(req, res, s, actionBody)) return;
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const db = readDb();
      const idx = db.items.findIndex(x => x.id === id);
      if (idx === -1) return send(res, 404, { error: 'not found' });
      const before = { ...db.items[idx] };
      if (!before.deleted) return send(res, 400, { error: '请先删除后再彻底删除' });
      db.items.splice(idx, 1);
      addLog(db, 'purge', s, before, null, before.title || before.id);
      await saveDb(db);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/items/')) {
      const s = requireAuth(req, res);
      if (!s) return;
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const db = readDb();
      const idx = db.items.findIndex(x => x.id === id);
      if (idx === -1) return send(res, 404, { error: 'not found' });
      const before = { ...db.items[idx] };
      if (!isAdminRole(s)) return send(res, 403, { error: '普通用户不能直接删除，请使用结束/下架流程' });
      db.items[idx] = { ...db.items[idx], deleted: true, deletedAt: now(), deletedBy: s.name, updatedAt: now(), updatedBy: s.name };
      addLog(db, 'admin_delete', s, before, db.items[idx]);
      await saveDb(db);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (!requireAuth(req, res)) return;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write('data: {"type":"ready"}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/mini/auth/check') {
      const body = await bodyJson(req);
      const name = normalizeName(body.name);
      const phone = normalizePhone(body.phone);
      if (!name || !phone) return send(res, 400, { error: '请填写姓名和手机号' });
      const db = readDb();
      const user = (db.users || []).find(row => (row.loginKey || `${row.name}:${row.phone}`) === `${name}:${phone}`);
      if (!user) return send(res, 404, { error: '未找到该账号，请确认姓名和手机号是否正确' });
      if (user.status === 'disabled') return send(res, 403, { error: '账号已停用，请联系管理员' });
      if (user.status !== 'approved') return send(res, 403, { error: '账号暂未开通，请联系管理员' });
      return send(res, 200, { ok: true, user: miniUserProfile(user) });
    }
    if (req.method === 'GET' && url.pathname === '/api/mini/me') {
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: false });
      if (!miniAuth) return;
      const user = (db.users || []).find(row => row.id === miniAuth.actor.userId || (row.loginKey || `${row.name}:${row.phone}`) === `${miniAuth.actor.name}:${miniAuth.actor.phone}`);
      if (!user || user.status !== 'approved') return send(res, 403, { error: user?.status === 'disabled' ? '账号已停用，请联系管理员' : '账号不可用，请联系管理员' });
      return send(res, 200, { ok: true, user: miniUserProfile(user), serverTime: now() });
    }
    if (req.method === 'GET' && url.pathname === '/api/mini/ping') {
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: true });
      if (!miniAuth) return;
      return send(res, 200, { ok: true, mode: miniAuth.legacy ? 'mini-program-legacy' : 'mini-program-session', serverTime: now() });
    }
    if (req.method === 'POST' && url.pathname === '/api/mini/bootstrap') {
      if (!MINI_BOOTSTRAP_ENABLED) return send(res, 403, { error: 'mini bootstrap disabled' });
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: true });
      if (!miniAuth) return;
      const body = await bodyJson(req);
      if (body.force === true && (!miniAuth.actor || !isSuperAdmin(miniAuth.actor))) return send(res, 403, { error: 'force bootstrap requires superadmin session' });
      if (body.confirm !== 'mini-program-source-of-truth') {
        return send(res, 400, { error: '缺少小程序初始化确认标记' });
      }
      if (db.meta?.miniBootstrapDone && body.force !== true) {
        return send(res, 200, {
          ok: true,
          skipped: true,
          bootstrappedAt: db.meta.miniBootstrapAt || '',
          count: db.items.length
        });
      }
      const sourceItems = Array.isArray(body.items) ? body.items : [];
      db.items = sourceItems
        .filter(item => item && typeof item === 'object')
        .map(miniBootstrapItem);
      db.meta = {
        ...(db.meta || {}),
        miniBootstrapDone: true,
        miniBootstrapAt: now(),
        miniBootstrapCount: db.items.length
      };
      addLog(db, 'mini_bootstrap', miniAuth.actor || { name: '微信小程序', role: 'mini' }, null, null, `count=${db.items.length}`);
      await saveDb(db);
      return send(res, 200, { ok: true, count: db.items.length, bootstrappedAt: db.meta.miniBootstrapAt });
    }
    if (req.method === 'POST' && url.pathname === '/api/mini/upload/image') {
      return saveMiniUpload(req, res, url, 'image');
    }
    if (req.method === 'POST' && url.pathname === '/api/mini/upload/video') {
      return saveMiniUpload(req, res, url, 'video');
    }
    if (req.method === 'GET' && url.pathname === '/api/mini/logs') {
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: true });
      if (!miniAuth) return;
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 300));
      return send(res, 200, { logs: db.logs.slice(0, limit).map(toMiniLog) });
    }
    if (req.method === 'GET' && url.pathname === '/api/mini/items') {
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: true });
      if (!miniAuth) return;
      const miniActor = miniAuth.actor || miniActorFromQuery(db, url);
      const includeDeleted = url.searchParams.get('includeDeleted') === '1';
      let rows = db.items.filter(item => includeDeleted || (!item.deleted && item.status !== 'offline' && item.offlineReviewStatus !== 'approved'));
      const side = normalizeEnum(url.searchParams.get('side'), ['supply', 'demand'], '');
      const category = text(url.searchParams.get('category'), 40);
      const updatedAfter = text(url.searchParams.get('updatedAfter'), 80);
      if (side) rows = rows.filter(item => item.side === side);
      if (category) rows = rows.filter(item => item.category === category);
      if (updatedAfter) {
        const since = Date.parse(updatedAfter);
        if (Number.isNaN(since)) return send(res, 400, { error: 'updatedAfter 时间格式无效' });
        rows = rows.filter(item => Date.parse(item.updatedAt || item.createdAt || '') > since);
      }
      return send(res, 200, { items: rows.map(item => miniItem(item, miniActor)), count: rows.length });
    }
    if (req.method === 'GET' && /^\/api\/mini\/items\/[^/]+$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: true });
      if (!miniAuth) return;
      const miniActor = miniAuth.actor || miniActorFromQuery(db, url);
      const includeDeleted = url.searchParams.get('includeDeleted') === '1';
      const item = db.items.find(x => x.id === id && (includeDeleted || (!x.deleted && x.status !== 'offline' && x.offlineReviewStatus !== 'approved')));
      if (!item) return send(res, 404, { error: '小程序信息不存在或已删除' });
      return send(res, 200, { item: miniItem(item, miniActor) });
    }
    if (req.method === 'POST' && url.pathname === '/api/mini/items') {
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: true });
      if (!miniAuth) return;
      const body = await bodyJson(req);
      const raw = normalizeMiniItemInput(body);
      const s = miniActor(raw, {}, miniAuth.actor);
      const validationError = validateMiniSupply(raw);
      if (validationError) return send(res, 400, { error: validationError });
      const item = cleanItem(raw, s);
      const duplicate = findRecentDuplicateItem(db.items, item);
      if (duplicate) return send(res, 200, { ok: true, duplicate: true, item: miniItem(duplicate, s) });
      db.items.unshift(item);
      addLog(db, 'mini_create', s, null, item);
      await saveDb(db);
      return send(res, 201, { ok: true, item: miniItem(item, s) });
    }
    if (req.method === 'PUT' && /^\/api\/mini\/items\/[^/]+$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: true });
      if (!miniAuth) return;
      const body = await bodyJson(req);
      const idx = db.items.findIndex(x => x.id === id && !x.deleted);
      if (idx === -1) return send(res, 404, { error: '小程序信息不存在或已删除' });
      const before = { ...db.items[idx] };
      try {
        assertEditableBusinessItem(before);
      } catch (e) {
        return send(res, e.status || 409, { error: e.message || '该条目状态已变化，请刷新后再操作' });
      }
      const raw = normalizeMiniItemInput(body, before);
      const s = miniActor(raw, before, miniAuth.actor);
      const validationError = validateMiniSupply(raw);
      if (validationError) return send(res, 400, { error: validationError });
      let next = cleanItem(raw, s, before);
      next = applyMiniSyncFields(next, body, s);
      db.items[idx] = next;
      addLog(db, 'mini_update', s, before, next);
      await saveDb(db);
      return send(res, 200, { ok: true, item: miniItem(next, s) });
    }
    if (req.method === 'POST' && /^\/api\/mini\/items\/[^/]+\/status$/.test(url.pathname)) {
      const parts = url.pathname.split('/');
      const id = decodeURIComponent(parts[parts.length - 2]);
      const db = readDb();
      const miniAuth = requireMiniAuth(req, res, url, db, { allowLegacy: true });
      if (!miniAuth) return;
      const body = await bodyJson(req);
      const requestedAction = normalizeStatusAction(text(body.action || '', 40));
      const idx = db.items.findIndex(x => x.id === id && !x.deleted);
      if (idx === -1) {
        const processed = db.items.find(x => x.id === id);
        if (processed) {
          if (isIdempotentProcessedStatus(processed, requestedAction)) {
            let actor;
            try {
              actor = miniStatusActor(db, body, processed, miniAuth.actor);
              assertOfflineApprovalPermission(processed, requestedAction, actor);
            } catch (e) {
              return send(res, e.status || 400, { error: e.message || '状态操作失败' });
            }
            return send(res, 200, {
              ok: true,
              item: miniItem(normalizeProcessedStatusForResponse(processed, requestedAction), actor),
              idempotent: true
            });
          }
          return send(res, 409, { error: '该下架申请已处理，请刷新列表' });
        }
        return send(res, 404, { error: '小程序信息不存在或已删除' });
      }
      const before = { ...db.items[idx] };
      let s;
      try {
        s = miniStatusActor(db, body, before, miniAuth.actor);
        if (isIdempotentProcessedStatus(before, requestedAction)) {
          assertOfflineApprovalPermission(before, requestedAction, s);
          return send(res, 200, {
            ok: true,
            item: miniItem(normalizeProcessedStatusForResponse(before, requestedAction), s),
            idempotent: true
          });
        }
        db.items[idx] = applyStatusAction(before, body, s);
      } catch (e) {
        return send(res, e.status || 400, { error: e.message || '状态操作失败' });
      }
      addLog(db, 'mini_status', s, before, db.items[idx]);
      await saveDb(db);
      return send(res, 200, { ok: true, item: miniItem(db.items[idx], s) });
    }
    if (req.method === 'DELETE' && /^\/api\/mini\/items\/[^/]+$/.test(url.pathname)) {
      const db = readDb();
      if (!requireMiniAuth(req, res, url, db, { allowLegacy: true })) return;
      return send(res, 403, { error: '小程序不能直接删除，请使用状态接口提交下架或自动下架原因' });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};

const server = http.createServer(requestHandler);
server.listen(PORT, '127.0.0.1', () => console.log(`juzhen listening on ${PORT}`));
if (ADMIN_DASHBOARD_PORT > 0 && ADMIN_DASHBOARD_PORT !== PORT) {
  const adminServer = http.createServer(requestHandler);
  adminServer.listen(ADMIN_DASHBOARD_PORT, '127.0.0.1', () => console.log(`juzhen admin dashboard listening on ${ADMIN_DASHBOARD_PORT}`));
}









