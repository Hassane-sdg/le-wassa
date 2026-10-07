const fs = require('fs');
const path = require('path');

const publishDirectory = path.resolve(__dirname, '..', 'dist');
const requiredFiles = [
  'acceuil.html',
  'menu.html',
  'table.html',
  'dashboard.html',
  'styles.css',
  'script.js',
  'restaurant-config.js',
  path.join('images', 'bar.png')
];
const allowedRootFiles = new Set([
  '401.html',
  'about.html',
  'acceuil.html',
  'admin-login.html',
  'admin-reservations.html',
  'admin-styles.css',
  'dashboard.html',
  'events.html',
  'index.html',
  'LeWassa.html',
  'menu.html',
  'reservation.html',
  'restaurant-config.js',
  'script.js',
  'styles.css',
  'table.html',
  'team.html'
]);
const allowedImageExtensions = new Set([
  '.avif', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp'
]);
const forbiddenPrivateFile = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?|[^/]*\.(?:bak|backup)|[^/]*\.log|package(?:-lock)?\.json)$/i;
const files = [];

function collectFiles(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name);
    const normalizedPath = relativePath.split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      throw new Error(`Netlify output contains a symbolic link: ${normalizedPath}`);
    }
    if (entry.isDirectory()) {
      if (prefix || entry.name !== 'images') {
        throw new Error(`Netlify output contains an unapproved directory: ${normalizedPath}`);
      }
      collectFiles(path.join(directory, entry.name), relativePath);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(normalizedPath);
    if (forbiddenPrivateFile.test(normalizedPath)) {
      throw new Error(`Netlify output contains a private file: ${normalizedPath}`);
    }
    if (prefix === 'images') {
      if (!allowedImageExtensions.has(path.extname(entry.name).toLowerCase())) {
        throw new Error(`Netlify output contains a non-image asset: ${normalizedPath}`);
      }
    } else if (!allowedRootFiles.has(entry.name)) {
      throw new Error(`Netlify output contains a file outside the frontend allowlist: ${normalizedPath}`);
    }
  }
}

if (!fs.existsSync(publishDirectory)) {
  throw new Error('Netlify output is missing. Run npm run build:netlify first.');
}

collectFiles(publishDirectory);
for (const file of requiredFiles) {
  if (!files.includes(file.split(path.sep).join('/'))) {
    throw new Error(`Required public frontend resource is missing from Netlify output: ${file}`);
  }
}

console.log(`PASS: checked ${files.length} Netlify files; required frontend assets exist and no private file types/directories are present.`);
