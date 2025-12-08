# 🖼️ Inline Image Assets + Performance Booster

A powerful SillyTavern extension for managing and displaying inline image assets in chat messages. Features ultra-fast local file uploads, batch processing, and performance optimizations for smooth scrolling even with thousands of messages.

<img width="1505" height="1015" alt="SillyTavern-12-08-2025_05_08_PM" src="https://github.com/user-attachments/assets/6cd266fc-4962-4f9c-95a5-f17676bf7244" />


---

## 🌟 Overview

**Inline Image Assets** transforms how you manage and display character images in SillyTavern. Instead of embedding large base64 data in character cards, this extension stores images as separate files, dramatically improving performance and enabling features like:

- Display character expressions and poses inline within chat messages
- Manage thousands of assets without lag or memory issues
- AI-friendly asset prompts for automatic image insertion

---

## ✨ Key Features

### ⚡ Ultra-Fast Upload Performance
- Upload 2,000+ assets in under 10 seconds
- Parallel batch processing with optimized concurrency
- No server dependency - all processing happens locally
- Zero lag or delay during uploads

### 🚀 Local File-Based Architecture
- Images stored in `user/files/`
- No base64 bloat in character cards
- Instant loading with browser-native caching

### 📦 Batch Processing
- Upload multiple files via drag & drop or file picker
- Multi-select deletion with checkbox mode
- Bulk download all assets as ZIP
- One-click migration from legacy base64 format

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

### Generating AI Prompts

1. Click the **📄 Copy Asset List** button
2. Paste the generated prompt into your character's world info (It is good works in AN↓)
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
**A:** Images are stored in possible location:
- `data/default-user/files/` (flat structure with prefix)

### Q: Do assets transfer when sharing character cards?
**A:** The asset metadata is stored in the character card, but the actual image files need to be shared separately. Use the ZIP download feature to package all assets.

### Q: Can the AI automatically choose which image to display?
**A:** Yes! Copy the asset list prompt to your character's description, and the AI will use the `%%img:name%%` tags appropriately based on context.

---

## 🔧 Troubleshooting

### Images not displaying in chat

1. **Check asset registration:** Open Asset Manager and verify the asset exists
2. **Verify file exists:** Check if the file is in `user/files/`
3. **Check tag format:** Ensure you're using `%%img:name%%` without file extension
4. **Case sensitivity:** Try matching the exact case of the asset name

### Upload fails with 403 error

This is usually a CSRF token issue:
1. Refresh the SillyTavern page
2. Try uploading again
3. If persistent, check browser console for detailed errors

### Assets not found after import

1. Click the **🔄 Refresh** button in Asset Manager
2. Check if files exist in the expected directory
3. Try the "Scan user/images/ folder" import option

### Performance issues with many assets

1. Ensure you're using the latest version (5.0.0+)
2. Close and reopen the Asset Manager popup
3. Check browser memory usage in Task Manager
4. Consider using WebP format for smaller file sizes

---

## 📋 Changelog

### Version 5.0.0 (Current)
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
