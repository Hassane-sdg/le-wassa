const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIRECTORY = process.env.WASSA_DATA_DIR
  ? path.resolve(process.env.WASSA_DATA_DIR)
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'LeWASSA')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'le-wassa');

function resolvePrivateDataPath(candidate) {
  const resolvedPath = path.resolve(candidate);
  const relativePath = path.relative(PROJECT_ROOT, resolvedPath);
  const isInsideProject = relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );

  if (isInsideProject) {
    throw new Error('Application data paths must be outside the project and public frontend directory');
  }

  return resolvedPath;
}

module.exports = { DATA_DIRECTORY, resolvePrivateDataPath };
