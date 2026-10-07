const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const publishDirectory = path.join(projectRoot, 'dist');
const publicFiles = [
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
];
const publicImageExtensions = new Set([
  '.avif', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp'
]);

function copyPublicImages(sourceDirectory, destinationDirectory) {
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to publish symbolic link in images/: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      copyPublicImages(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile() || !publicImageExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    fs.mkdirSync(destinationDirectory, { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

fs.rmSync(publishDirectory, { recursive: true, force: true });
fs.mkdirSync(publishDirectory, { recursive: true });

for (const file of publicFiles) {
  const sourcePath = path.join(projectRoot, file);
  if (!fs.statSync(sourcePath).isFile()) {
    throw new Error(`Required public frontend file is missing: ${file}`);
  }
  fs.copyFileSync(sourcePath, path.join(publishDirectory, file));
}

copyPublicImages(path.join(projectRoot, 'images'), path.join(publishDirectory, 'images'));

const publishedFiles = [];
function listPublishedFiles(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      listPublishedFiles(path.join(directory, entry.name), relativePath);
    } else {
      publishedFiles.push(relativePath);
    }
  }
}

listPublishedFiles(publishDirectory);
console.log(`Created isolated Netlify frontend output (${publishedFiles.length} files).`);
