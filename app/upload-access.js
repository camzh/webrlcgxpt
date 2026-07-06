const path = require('path');

const PUBLIC_UPLOAD_MEDIA_DIRS = [
  { prefix: '/uploads/mini/images/', extensions: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']) },
  { prefix: '/uploads/mini/videos/', extensions: new Set(['.mp4', '.mov', '.webm']) },
  { prefix: '/uploads/web/images/', extensions: new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']) },
  { prefix: '/uploads/web/videos/', extensions: new Set(['.mp4', '.mov', '.webm']) }
];

function isPublicUploadMediaPath(pathname) {
  if (typeof pathname !== 'string') return false;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (error) {
    return false;
  }

  if (decoded.includes('\\')) return false;
  if (path.posix.normalize(decoded) !== decoded) return false;

  return PUBLIC_UPLOAD_MEDIA_DIRS.some(({ prefix, extensions }) => {
    if (!decoded.startsWith(prefix)) return false;
    const filename = decoded.slice(prefix.length);
    if (!filename || filename.includes('/')) return false;
    return extensions.has(path.posix.extname(filename).toLowerCase());
  });
}

module.exports = {
  isPublicUploadMediaPath
};
