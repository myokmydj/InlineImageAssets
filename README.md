# 🖼️ Inline Image Assets + Performance Booster

A powerful SillyTavern extension for managing and displaying inline image assets in chat messages. Features ultra-fast local file uploads, batch processing, and performance optimizations for smooth scrolling even with thousands of messages.

---

## 🌟 Overview

**Inline Image Assets** transforms how you manage and display character images in SillyTavern. Instead of embedding large base64 data in character cards, this extension stores images as separate files, dramatically improving performance and enabling features like:

- Display character expressions and poses inline within chat messages
- Manage thousands of assets without lag or memory issues
- Seamless integration with charx character format
- AI-friendly asset prompts for automatic image insertion

---

## ✨ Key Features

### ⚡ Ultra-Fast Upload Performance
- Upload 2,000+ assets in under 10 seconds
- Parallel batch processing with optimized concurrency
- No server dependency - all processing happens locally
- Zero lag or delay during uploads

### 🚀 Local File-Based Architecture
- Preferred storage: `user/images/{characterName}/` (per-character folders)
- Fallback storage (older SillyTavern builds): `user/files/` (flat structure with prefix)
- No base64 bloat in character cards
- Instant loading with browser-native caching

### 📦 Batch Processing
- Upload multiple files via drag & drop or file picker
- Multi-select deletion with checkbox mode
- Bulk download all assets as ZIP
- One-click migration from legacy base64 format
- One-click migration from legacy `user/files` layout → per-character folders

### 🎯 Performance Optimizations
- CSS containment for smooth scrolling
- Lazy loading with IntersectionObserver
- Intelligent render queue with idle callbacks
- Memory-optimized thumbnail caching

### 🎨 User-Friendly Interface
- Intuitive asset manager popup
- Folder-based grouping by asset name prefix
- Tag system for organization
- Full-size image preview on click
- Real-time upload progress indicator

---

### Verification

After installation, you should see a new **image icon** (🖼️) button in the character description panel, next to the media overrides button.

---

## 📖 Usage

### Opening the Asset Manager

1. Select a character in SillyTavern
2. Click the **🖼️ Images** button in the character panel
3. The Asset Manager popup will open

### Uploading Assets

**Drag & Drop:**
- Simply drag image files into the gallery area
- Multiple files can be dropped at once

**File Picker:**
- Click the **Upload** button
- Select one or more image files
- Supported formats: PNG, JPG, JPEG, GIF, WebP, BMP, SVG

### Using Assets in Chat

Insert images in AI responses using the tag format:

```
%%img:assetname%%
```

**Example:**
```
*She smiled warmly* 
%%img:smile%% 
"Hello there!"
```

The tag will be automatically replaced with the corresponding image.

---

## 🧩 Custom Macros (Extension Asset URLs)

한국어 가이드: [MACROS_KO.md](MACROS_KO.md)

This extension also provides a **SillyTavern-style macro resolver** compatible with the convention:

```
{{macroName::parameter}}
```

These macros are designed to let SillyTavern HTML/JS/CSS (or scripts executed by other extensions like JS-Slash-Runner) reference files **bundled inside this extension folder** (images, CSS, JS, HTML, media files).

How it works:

- **Path macros** resolve to the extension’s own static-serving URL (derived from `import.meta.url`). This is cross-platform and works on Windows/Mac/Linux.
- **Existence checks** are done with `HEAD`/`GET` requests.
- **File listing** cannot be done from the browser, so `{{iaListFiles::...}}` uses a generated `assets.index.json` by default.
- If your SillyTavern build mounts extension backend routes, the macros will automatically prefer the backend for listing/MIME/caching.

### Provided Macros

Recommended (single unified macro):

- `{{ia:img:path}}` → URL for an image file inside this extension
- `{{ia:css:path}}` → URL for a CSS file inside this extension
- `{{ia:js:path}}` → URL for a JavaScript file inside this extension
- `{{ia:html:path}}` → URL for an HTML file inside this extension
- `{{ia:list:dir|recursive=1|ext=png,jpg|format=json}}` → JSON string or newline list

Chat asset shorthand (by name, not path):

- `{{ia:smile}}` → resolves `smile` using this extension’s **character assets first**, then **persona assets**
- `{{ia:char:smile}}` → character-only
- `{{ia:user:smile}}` / `{{ia:persona:smile}}` → persona-only

Random pick by prefix:

- `{{ia:rand:card_|scope=char}}` → randomly picks a character asset whose name starts with `card_`
- Options: `scope=char|user|persona|both`, `prefer=char|user`, `seed=...`, `mode=abs|rel`, `fallback=...`

Random pick from ALL assets (no prefix):

- `{{ia:randAll:scope=both}}` → randomly picks from all available character+persona assets
- Options: `scope=char|user|persona|both`, `prefer=char|user`, `seed=...`, `mode=abs|rel`, `fallback=...`

Prefix delimiter support:

- `{{ia:rand:alice}}` matches `alice_...`, `alice-...`, `alice....` (and exact `alice`).
- If you include a delimiter explicitly (e.g. `card_`), it behaves as a plain `startsWith`.

Design helper macros (generate HTML/CSS snippets):

- `{{ia:imgTag:smile|scope=char|class=inline-asset-image|alt=Smile}}` → `<img ...>`
- `{{ia:bgUrl:smile|scope=char}}` → `url("...")`
- `{{ia:bgStyle:smile|scope=char}}` → `background-image:url("...");`
- `{{ia:cssLink:style.css}}` → `<link rel="stylesheet" href="...">`
- `{{ia:jsModule:some.js}}` → `<script type="module" src="..."></script>`

Compatibility (legacy, still supported):

- `{{iaImagePath::path}}`
- `{{iaCssPath::path}}`
- `{{iaJsPath::path}}`
- `{{iaHtmlPath::path}}`
- `{{iaListFiles::dir|recursive=1|ext=png,jpg|format=json}}`

### Options (Pipe Syntax)

Options are appended with `|key=value`:

- `mode=abs` (default): absolute-from-origin URL (starts with `/...`)
- `mode=rel`: relative URL (no leading slash)
- `fallback=...`: used when the file does not exist or path is rejected

For chat-asset shorthand (`{{ia:smile}}`), you can also use:

- `prefer=char|user` (default `char`) when both scopes are allowed

**Input path forms supported:**

- Relative: `images/logo.png`
- Absolute-from-origin (must be inside this extension): `/.../InlineImageAssets/images/logo.png`
- Full URL (must be same-origin and inside this extension): `https://your-host/.../InlineImageAssets/images/logo.png`

### Usage Example (Async)

These macros resolve **asynchronously** to avoid blocking the UI.

```js
const html = await window.inlineImageAssetsMacros.resolve(
	`<img src="{{ia:img:images/logo.png|fallback=/user/files/placeholder.png}}">`
);
document.querySelector('#somewhere').innerHTML = html;
```

### Using inside inline CSS (background-image)

**Do not** pass a Windows filesystem path like `C:\\Users\\...` into a macro. Browsers cannot load local disk paths, and the macro sanitizer rejects them for security.

Instead, resolve to a web URL and use it in `url(...)`:

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
	`<div class="card-image" style="background-image:url('{{ia:char:card_00_fool}}');"></div>`
);
document.querySelector('#somewhere').innerHTML = html;
```

### Random card_ image (character assets)

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
	`<div class="card-image" style="background-image:url('{{ia:rand:card_|scope=char}}');"></div>`
);
document.querySelector('#somewhere').innerHTML = html;
```

If you want deterministic randomness per message, provide a seed (you can use Tavern-Helper macros as seed):

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
	`<div class="card-image" style="background-image:url('{{ia:rand:card_|scope=char|seed={{lastMessageId}}}}');"></div>`
);
```

### Using with JS-Slash-Runner / Tavern-Helper macros

JS-Slash-Runner (Tavern-Helper) provides built-in macros like `{{userAvatarPath}}` and `{{charAvatarPath}}`.
To use both systems together:

```js
const mixed = `
	<img src="{{userAvatarPath}}">
	<img src="{{iaImagePath::assets/logo.png|fallback=/user/files/placeholder.png}}">
`;

const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(mixed);
document.querySelector('#somewhere').innerHTML = html;
```

### Directory Listing Example

```js
const json = await window.inlineImageAssetsMacros.resolve(
	`{{iaListFiles::templates|recursive=1|ext=png,jpg|format=json}}`
);
const entries = JSON.parse(json);
console.log(entries);
```

### Generating `assets.index.json`

After adding/removing assets inside this extension folder, regenerate the index:

```bash
cd "<your SillyTavern>/data/default-user/extensions/InlineImageAssets"
node tools/build-assets-index.mjs
```

### Security Notes

- Paths are sanitized on the client and validated again on the backend.
- Directory traversal (`..`) and absolute paths are rejected.
- Only files under this extension directory can be served/listed.


### Persona Assets (Optional)

This extension also supports **Persona assets** as a fallback when a character asset is not found.

- Open the **Persona** panel and click the **Inline Image Assets** persona button (added near other persona controls).
- Upload/manage persona images there.
- In chat, use the same tag format: `%%img:assetname%%`
	- Resolution order: **Character assets first**, then **Persona assets**.

### Generating AI Prompts

1. Click the **📄 Copy Asset List** button
2. Paste the generated prompt into your character's description or system prompt
3. The AI will know which images are available and how to use them

**Generated Prompt Example:**
```
### {{char}}'s Image Asset Usage Guide

**Available Image Filenames:**
"smile", "happy", "sad", "angry_[1, 2, 3]"

**How to Display an Image:**
Use the tag `%%img:filename%%` in your response.
```

### Organizing with Tags

1. Click the tag input field below any asset
2. Type a tag name and press Enter
3. Use the tag filters in the toolbar to filter assets
4. Click the ✕ on a tag to remove it

### Bulk Operations

**Multi-Select Mode:**
1. Click the **☑️ Selection** button to enable selection mode
2. Click assets or checkboxes to select them
3. Use **Select All** to select everything
4. Click **🗑️ Delete Selected** to remove selected assets

**Download as ZIP:**
- Click the **📦 ZIP** button to download all assets as a compressed archive

---

## 💻 System Requirements

### Supported Image Formats

- PNG (recommended for quality)
- JPEG/JPG (recommended for photos)
- WebP (best compression)
- GIF (animated images)
- BMP
- SVG

### File Size Limits

- Maximum file size: **10MB per image**
- Recommended: Under 2MB for optimal performance

---

## ❓ FAQ

### Q: How many assets can I have per character?
**A:** There's no hard limit. The extension has been tested with 2,000+ assets without issues. Performance remains smooth due to lazy loading and pagination.

### Q: Will this slow down my SillyTavern?
**A:** No. The Performance Booster component is always active and actually improves scrolling performance. Asset rendering only activates when a character has registered assets.

### Q: Where are the images stored?
**A:** It depends on your SillyTavern build:
- Preferred: `data/default-user/images/{characterName}/` (served as `/user/images/{characterName}/...`)
- Fallback: `data/default-user/files/` (served as `/user/files/...`, flat structure with prefix)

### Q: Do assets transfer when sharing character cards?
**A:** The asset metadata is stored in the character card, but the actual image files need to be shared separately. Use the ZIP download feature to package all assets.

### Q: Can the AI automatically choose which image to display?
**A:** Yes! Copy the asset list prompt to your character's description, and the AI will use the `%%img:name%%` tags appropriately based on context.

---

## 🔧 Troubleshooting

### Images not displaying in chat

1. **Check asset registration:** Open Asset Manager and verify the asset exists
2. **Verify file exists:** Check `user/images/{characterName}/` first, then `user/files/` (fallback)
3. **Check tag format:** Ensure you're using `%%img:name%%` without file extension
4. **Case sensitivity:** Try matching the exact case of the asset name

### Upload fails with 403 error

This is usually a CSRF token issue:
1. Refresh the SillyTavern page
2. Try uploading again
3. If persistent, check browser console for detailed errors

### Assets not found after import

1. Click the **🔄 Refresh** button in Asset Manager
2. Check if files exist in the expected directory (`user/images/{characterName}/` or fallback `user/files/`)
3. If you are on an older SillyTavern build without the Images API, assets will remain in `user/files/`

### Performance issues with many assets

1. Ensure you're using the latest version (5.0.0+)
2. Close and reopen the Asset Manager popup
3. Check browser memory usage in Task Manager
4. Consider using WebP format for smaller file sizes

---

## 📋 Changelog

### Version 5.2.0 (Current) — 2025-12-12
- 📁 Preferred per-character storage via SillyTavern Images API (`/api/images/*`) into `user/images/{characterName}/`
- 🔁 Fallback to legacy `user/files/` when Images API is unavailable
- 🧭 Listing/scanning now uses `/api/images/list` first for reliable discovery
- 🧳 Migration tools:
	- legacy base64 → files/images
	- legacy `user/files` flat layout → per-character folders
- 🧩 Better name/path compatibility (canonical matching + dedupe) to prevent duplicate assets and reduce memory blowups
- 👤 Persona asset manager button + persona asset fallback support in `%%img:...%%` resolution

### Version 5.0.0
- 🚀 Complete rewrite with file-based storage
- ⚡ Ultra-fast parallel uploads (2,000 files in <10 seconds)
- 🎯 Global Performance Booster (always active)
- 📁 Folder-based asset grouping in UI
- ☑️ Multi-select deletion mode
- 📦 ZIP download feature
- 🔍 Auto-scan user/images/ directory
- 🌐 Unicode character name support
- 🔄 Legacy base64 migration tool

### Version 4.x
- Added charx asset import
- Improved tag filtering
- Performance optimizations

### Version 3.x
- Initial file-based storage
- Basic asset management UI

### Version 2.x
- Base64 embedded storage
- Simple tag system

### Version 1.x
- Initial release
- Basic inline image display