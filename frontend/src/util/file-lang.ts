// Shared file-classification helpers — viewability, icon by extension, and
// the extension → highlight-language map. Pulled out of FileEditor so the
// CodeMirror bundle and any future file-aware UI can reuse them without
// dragging in the FileEditor module.

const VIEWABLE_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'php', 'pl', 'lua', 'r', 'dart', 'ex', 'exs',
  'clj', 'hs', 'ml', 'scala', 'kt', 'swift', 'go', 'rs',
  'c', 'cpp', 'h', 'hpp', 'cs', 'java',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'html', 'htm', 'xml', 'xhtml', 'css', 'scss', 'sass', 'less',
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'sql', 'graphql', 'proto', 'tf', 'dockerfile',
]);

// Files with no extension that are conventionally text/config.
const KNOWN_NOEXT_TEXT_FILES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'rakefile',
  'gemfile', 'procfile', 'jenkinsfile', 'vagrantfile', 'brewfile',
  'license', 'licence', 'readme', 'changelog', 'authors', 'contributors',
  'notice', 'copying', 'install', 'todo', 'history', 'news', 'maintainers',
  'codeowners',
]);

// Common dotfile names we know are text. The fallback below also accepts
// any single-segment dotfile (".foo" with no further dot) as text, so this
// list is mostly belt-and-braces for files like ".env.local".
const KNOWN_DOTFILES = new Set([
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
  '.env.example', '.env.sample',
  '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.gitconfig',
  '.editorconfig', '.dockerignore', '.gcloudignore', '.npmignore',
  '.npmrc', '.yarnrc', '.nvmrc', '.node-version', '.python-version',
  '.ruby-version', '.tool-versions',
  '.prettierrc', '.prettierignore', '.eslintrc', '.eslintignore',
  '.stylelintrc', '.babelrc', '.browserslistrc', '.flowconfig',
  '.htaccess', '.bashrc', '.zshrc', '.profile', '.bash_profile',
  '.vimrc', '.tmux.conf',
]);

// Extensions we know are NOT text — keeps the "unknown + small file" fallback
// in shouldOpenInEditor() from cheerfully loading a 4 MB JPEG into CodeMirror.
const KNOWN_BINARY_EXTS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff',
  'avif', 'heic', 'heif', 'psd', 'ai', 'eps',
  // audio
  'mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus', 'aac', 'wma', 'mid', 'midi',
  // video
  'mp4', 'webm', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'm4v', '3gp',
  // documents / office
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz', '7z', 'rar', 'xz', 'lz4', 'zst',
  // executables / installers / libraries
  'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'war', 'app',
  'msi', 'deb', 'rpm', 'apk', 'ipa', 'pkg',
  // object / compiled
  'o', 'obj', 'a', 'lib', 'pyc', 'pyo', 'pdb',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // disk images / databases
  'iso', 'dmg', 'img', 'db', 'sqlite', 'sqlite3', 'mdb', 'accdb',
  // misc binary
  'bin', 'dat', 'pack',
]);

// Cap for the "unknown extension → still try to open as text" fallback.
// 5 MB matches the source comment in the chat-input flow; anything bigger
// hits CodeMirror hard and is almost certainly the wrong thing to inline.
const MAX_UNKNOWN_TEXT_SIZE = 5 * 1024 * 1024;

export function fileExt(name: string): string {
  return (name || '').toLowerCase().split('.').pop() ?? '';
}

// Shared file-size formatter — units stop at GB so very-large queue totals
// stay readable (anything past TB shows in GB).
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Strict "we know this is text" check — by extension or known name. Doesn't
// look at size, so safe to call from anywhere (chat chips, render hints).
// For "should I open this in the editor?" use shouldOpenInEditor() — that
// adds the small-unknown-file fallback FilePicker / FileManager want.
export function isViewable(name: string): boolean {
  const lower = (name || '').toLowerCase();
  if (!lower) return false;
  if (KNOWN_NOEXT_TEXT_FILES.has(lower)) return true;
  if (KNOWN_DOTFILES.has(lower)) return true;
  // Generic dotfile catch: ".foo" with no inner dot. Covers anything we
  // didn't list explicitly (e.g. ".envrc", ".tmuxinator", ".rspec").
  if (lower.startsWith('.') && !lower.slice(1).includes('.')) return true;
  return VIEWABLE_EXTS.has(fileExt(name));
}

// Single source of truth for "clicking this file should open our text/code
// editor". Used by FilePicker, FileManager, and the mentioned-files chip
// click path so the three stay consistent.
//   – known text (extension / dotfile / Dockerfile-style name) → yes
//   – known binary (image, archive, exe, font, …)               → no
//   – unknown ext, size known and ≤ 5 MB                         → yes
//   – unknown ext, size not provided                             → yes
//     (caller has elected to try; the editor itself shows a binary warning
//      if the file turns out not to be text)
export function shouldOpenInEditor(name: string, size?: number): boolean {
  if (isViewable(name)) return true;
  const ext = fileExt(name);
  if (KNOWN_BINARY_EXTS.has(ext)) return false;
  if (typeof size === 'number') return size <= MAX_UNKNOWN_TEXT_SIZE;
  return true;
}

export function isMarkdown(name: string): boolean {
  const ext = fileExt(name);
  return ext === 'md' || ext === 'markdown';
}

export function fileIcon(name: string): string {
  const ext = fileExt(name);
  const map: Record<string, string> = {
    js: '📜', ts: '📜', mjs: '📜', cjs: '📜', jsx: '📜', tsx: '📜',
    py: '🐍', sh: '⚡', bash: '⚡', json: '📋', md: '📝', markdown: '📝',
    txt: '📄', csv: '📊', html: '🌐', htm: '🌐', css: '🎨', sql: '🗄',
    yml: '⚙', yaml: '⚙', toml: '⚙', ini: '⚙', env: '🔑', conf: '⚙',
    rs: '🦀', go: '🐹', rb: '💎', php: '🐘', c: '🔧', cpp: '🔧', h: '🔧',
  };
  return map[ext] || '📄';
}

// Map file extension → Shiki/highlight.js language name. Used both by Shiki's
// view-mode highlighting and by the CodeMirror language loader.
export function shikiLang(ext: string): string {
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell',
    html: 'html', htm: 'html', xml: 'xml', xhtml: 'html',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql',
    md: 'markdown', markdown: 'markdown',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', java: 'java',
    kt: 'kotlin', swift: 'swift', dart: 'dart',
    dockerfile: 'dockerfile', tf: 'hcl', proto: 'protobuf', graphql: 'graphql',
    lua: 'lua', r: 'r', scala: 'scala',
  };
  return map[ext] || 'text';
}
