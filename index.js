
import { getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";

(function () {
    const DEBUG = true; // Enable debug logging temporarily
    const log = (message, ...args) => {
        if (DEBUG) console.log(`[InlineImageAssets:DEBUG] ${message}`, ...args);
    };

    // Captures content between %%img: and %%
    const tagRegex = /%%img:([^%]+)%%/g;

    // === FILE SYSTEM CONFIGURATION ===
    // Note: SillyTavern's /api/files/upload validates filename with regex /^[a-zA-Z0-9_\-.]+$/
    // This means NO slashes are allowed in the filename!
    // We use a flat structure with double underscore as separator: inline_assets__CharName__filename.png
    const IMAGE_PREFIX = 'inline_assets';
    const PATH_SEPARATOR = '__'; // Use double underscore instead of slash
    const THUMBNAIL_SIZE = 150;
    const SUPPORTED_FORMATS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
    
    // Alternative image paths to check (for user/images/{characterName}/ structure)
    // SillyTavern may serve images from different endpoints depending on configuration
    const ALTERNATIVE_IMAGE_PATHS = [
        '/user/images',      // user/images/{characterName}/
        '/user/files',       // user/files/ (flat structure)
        '/characters',       // characters/{characterName}/
    ];

    // === CSRF TOKEN MANAGEMENT ===
    // SillyTavern uses csrf-sync library which requires fetching token from /csrf-token endpoint
    let cachedCsrfToken = null;
    let csrfTokenPromise = null;
    let csrfDisabled = false; // Track if CSRF is disabled on this server

    /**
     * Fetches the CSRF token from SillyTavern's /csrf-token endpoint
     * Uses caching to avoid repeated requests
     * @returns {Promise<string|null>} - CSRF token or null
     */
    async function fetchCsrfToken() {
        // If CSRF is disabled, don't try to fetch
        if (csrfDisabled) {
            return null;
        }
        
        // Return cached token if available
        if (cachedCsrfToken) {
            return cachedCsrfToken;
        }
        
        // If a fetch is already in progress, wait for it
        if (csrfTokenPromise) {
            return csrfTokenPromise;
        }
        
        // Fetch new token
        csrfTokenPromise = (async () => {
            try {
                const response = await fetch('/csrf-token', {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.token === 'disabled') {
                        csrfDisabled = true;
                        log('CSRF is disabled on this server');
                        return null;
                    }
                    cachedCsrfToken = data.token;
                    log('CSRF token fetched successfully:', cachedCsrfToken?.substring(0, 10) + '...');
                    return cachedCsrfToken;
                } else if (response.status === 404) {
                    // CSRF endpoint doesn't exist - CSRF might be disabled
                    csrfDisabled = true;
                    log('CSRF endpoint not found - assuming disabled');
                    return null;
                } else {
                    console.warn('[InlineImageAssets] Failed to fetch CSRF token:', response.status);
                    return null;
                }
            } catch (error) {
                console.error('[InlineImageAssets] Error fetching CSRF token:', error);
                // Don't mark as disabled on network errors
                return null;
            } finally {
                csrfTokenPromise = null;
            }
        })();
        
        return csrfTokenPromise;
    }

    /**
     * Invalidates the cached CSRF token (call when token might be stale)
     */
    function invalidateCsrfToken() {
        cachedCsrfToken = null;
        csrfTokenPromise = null;
        // Don't reset csrfDisabled - if it was disabled, it stays disabled
    }

    /**
     * Gets common headers for API requests including CSRF token
     * @returns {Promise<Object>} - Headers object
     */
    async function getApiHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };
        
        if (!csrfDisabled) {
            const csrfToken = await fetchCsrfToken();
            if (csrfToken) {
                headers['X-CSRF-Token'] = csrfToken;
            }
        }
        
        return headers;
    }

    // === GLOBAL PERFORMANCE BOOSTER ===
    // Always active, regardless of assets
    let performanceBoosterInitialized = false;
    let performanceStyleElement = null;

    // === ASSET RENDERING MODE ===
    // Only active when character has assets
    let isAssetRenderingActive = false;
    let chatObserver = null; // MutationObserver - only created when needed

    // === PERFORMANCE CACHES ===
    // Asset name -> file path Map for O(1) lookups (rebuilt when character changes)
    let assetCache = new Map();
    let cachedCharacterId = null;
    let cachedCharacterName = null;
    
    // Persona asset cache (separate from character)
    let personaAssetCache = new Map();
    let cachedPersonaName = null;
    const PERSONA_PREFIX = 'inline_assets__persona__';
    
    // Thumbnail cache for popup performance
    let thumbnailCache = new Map();
    
    // Track which messages have been processed to avoid re-processing
    // Note: These need to be let, not const, so we can reset them on chat change
    let processedMessages = new WeakSet();
    
    // Track messages that definitely have no %%img: tags (skip future checks)
    let noImageTagMessages = new WeakSet();

    // Batch rendering queue
    let renderQueue = [];
    let isRenderScheduled = false;

    // IntersectionObserver for lazy loading
    let visibilityObserver = null;

    // === SCROLL PERFORMANCE ===
    let isScrolling = false;
    let scrollTimeout = null;
    let scrollListenerAttached = false;
    let lastScrollTime = 0;
    const SCROLL_THROTTLE = 150; // ms to wait after scroll stops
    
    // Use smaller batch size for smoother scrolling
    const BATCH_SIZE = 8; // Process fewer messages per frame for smoother scrolling
    
    // requestIdleCallback polyfill
    const requestIdleCallback = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
    const cancelIdleCallback = window.cancelIdleCallback || clearTimeout;

    // === FILE SYSTEM UTILITIES ===
    
    /**
     * Sanitizes a single path segment (filename or directory name)
     * SillyTavern only accepts alphanumeric, '_', '-' characters (and '.' for extensions)
     * @param {string} segment - Original path segment
     * @returns {string} - Sanitized segment
     */
    function sanitizePathSegment(segment) {
        // First, normalize unicode characters (e.g., ū -> u)
        let sanitized = segment.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        
        // Replace any character that is not alphanumeric, underscore, hyphen, or dot with underscore
        // Keep dots for file extensions
        sanitized = sanitized.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        
        // Remove consecutive underscores
        sanitized = sanitized.replace(/_+/g, '_');
        
        // Remove leading/trailing underscores (but keep leading dot for hidden files if needed)
        sanitized = sanitized.replace(/^_+|_+$/g, '');
        
        // Ensure the segment is not empty
        if (!sanitized || sanitized === '.') {
            sanitized = 'unnamed';
        }
        
        return sanitized.trim();
    }

    /**
     * Sanitizes a filename (without path)
     * @param {string} name - Original filename
     * @returns {string} - Sanitized filename
     */
    function sanitizeFilename(name) {
        return sanitizePathSegment(name);
    }

    /**
     * Sanitizes a filename base (without extension) for SillyTavern /api/images/upload
     * Keeps only [a-zA-Z0-9._-] and converts spaces to underscores.
     * @param {string} baseName
     * @returns {string}
     */
    function sanitizeImageBaseName(baseName) {
        let name = (baseName || '').toString().trim();
        name = name.replace(/\s+/g, '_');
        name = name.replace(/[^a-zA-Z0-9._-]/g, '_');
        name = name.replace(/_+/g, '_');
        name = name.replace(/^_+|_+$/g, '');
        if (!name) name = 'unnamed';
        return name;
    }

    /**
     * Creates a stable, comparable key for an asset name.
     * Used to dedupe between:
     * - user-provided names (may contain spaces/unicode)
     * - actual stored filenames for /api/images (sanitized base names)
     * @param {string} name
     * @returns {string}
     */
    function getCanonicalAssetKey(name) {
        return sanitizeImageBaseName(name).toLowerCase();
    }

    /**
     * Normalizes image format/extension from a filename extension or MIME type.
     * @param {string} extOrMime
     * @returns {string}
     */
    function normalizeImageFormat(extOrMime) {
        let format = (extOrMime || '').toString().trim().toLowerCase();
        if (format.startsWith('image/')) {
            format = format.substring('image/'.length);
        }
        if (format === 'svg+xml') format = 'svg';
        if (format === 'jpeg') format = 'jpg';
        format = format.replace(/[^a-z0-9]/g, '');
        return format;
    }

    /**
     * Splits and sanitizes an incoming filename into { baseName, format, fullFilename } for /api/images/upload.
     * @param {string} originalFilename
     * @param {string} mimeType
     */
    function getImageNameAndFormat(originalFilename, mimeType) {
        const rawName = (originalFilename || '').toString().trim();
        const lastDot = rawName.lastIndexOf('.');

        let base = rawName;
        let ext = '';
        if (lastDot > 0 && lastDot < rawName.length - 1) {
            base = rawName.substring(0, lastDot);
            ext = rawName.substring(lastDot + 1);
        }

        let format = normalizeImageFormat(ext);
        if (!format) {
            format = normalizeImageFormat(mimeType);
        }
        if (!format || !SUPPORTED_FORMATS.includes(format)) {
            // Best-effort fallback for unknown/unsupported types
            format = 'png';
        }

        const baseName = sanitizeImageBaseName(base);
        const fullFilename = `${baseName}.${format}`;

        return { baseName, format, fullFilename };
    }

    /**
     * Sanitizes a full path by sanitizing each segment individually
     * @param {string} fullPath - Full path with slashes
     * @returns {string} - Sanitized path
     */
    function sanitizePath(fullPath) {
        // Split by both forward and back slashes
        const segments = fullPath.split(/[\/\\]/);
        
        // Sanitize each segment
        const sanitizedSegments = segments.map(segment => {
            if (!segment) return ''; // Handle empty segments (e.g., leading slash)
            return sanitizePathSegment(segment);
        }).filter(s => s); // Remove empty segments
        
        // Rejoin with forward slashes
        return sanitizedSegments.join('/');
    }

    /**
     * Gets the filename prefix for a character's assets
     * Uses flat structure: inline_assets__CharName__
     * @param {string} characterName - Character name
     * @returns {string} - Filename prefix
     */
    function getCharacterFilePrefix(characterName) {
        const sanitizedName = sanitizePathSegment(characterName);
        return `${IMAGE_PREFIX}${PATH_SEPARATOR}${sanitizedName}${PATH_SEPARATOR}`;
    }

    /**
     * Gets the filename prefix for a persona's assets
     * Uses flat structure: inline_assets__persona__PersonaName__
     * @param {string} personaName - Persona name
     * @returns {string} - Filename prefix
     */
    function getPersonaFilePrefix(personaName) {
        const sanitizedName = sanitizePathSegment(personaName);
        return `${PERSONA_PREFIX}${sanitizedName}${PATH_SEPARATOR}`;
    }

    /**
     * Gets the full filename for an asset (flat structure, no slashes)
     * @param {string} characterName - Character name
     * @param {string} assetFilename - Asset filename
     * @returns {string} - Full flat filename
     */
    function getAssetFullFilename(characterName, assetFilename) {
        const prefix = getCharacterFilePrefix(characterName);
        const sanitizedFilename = sanitizePathSegment(assetFilename);
        return `${prefix}${sanitizedFilename}`;
    }

    /**
     * Gets the full filename for a persona asset (flat structure, no slashes)
     * @param {string} personaName - Persona name
     * @param {string} assetFilename - Asset filename
     * @returns {string} - Full flat filename
     */
    function getPersonaAssetFullFilename(personaName, assetFilename) {
        const prefix = getPersonaFilePrefix(personaName);
        const sanitizedFilename = sanitizePathSegment(assetFilename);
        return `${prefix}${sanitizedFilename}`;
    }

    /**
     * Extracts the original asset name from a persona filename
     * @param {string} fullFilename - Full filename with prefix
     * @param {string} personaName - Persona name
     * @returns {string} - Original asset name without extension
     */
    function extractPersonaAssetName(fullFilename, personaName) {
        const prefix = getPersonaFilePrefix(personaName);
        let name = fullFilename;
        if (name.startsWith(prefix)) {
            name = name.substring(prefix.length);
        }
        // Remove extension
        const lastDot = name.lastIndexOf('.');
        if (lastDot > 0) {
            name = name.substring(0, lastDot);
        }
        return name;
    }

    /**
     * Gets the full URL for an asset image
     * SillyTavern serves user files from multiple endpoints:
     * - /user/files/ for flat structure
     * - /user/images/{characterName}/ for directory structure
     * @param {string} characterName - Character name (can include unicode characters)
     * @param {string} assetFilename - Asset filename (already includes prefix or not)
     * @param {boolean} useImageDir - If true, use /user/images/{characterName}/ path
     * @returns {string} - Full URL path
     */
    function getAssetUrl(characterName, assetFilename, useImageDir = false) {
        // If it's already a full URL path, return as-is
        if (assetFilename.startsWith('/')) {
            return assetFilename;
        }
        
        // If using image directory structure
        if (useImageDir) {
            // Use original character name for the path (supports unicode like Ryūnosuke)
            // The browser will handle URL encoding automatically
            return `/user/images/${characterName}/${assetFilename}`;
        }
        
        // Default: flat structure in /user/files/
        // If filename already has the prefix, use it directly
        const prefix = getCharacterFilePrefix(characterName);
        const fullFilename = assetFilename.startsWith(prefix)
            ? assetFilename
            : getAssetFullFilename(characterName, assetFilename);
        
        // SillyTavern serves files from /user/files/ endpoint
        // The actual files are stored in data/default-user/files/ on disk
        return `/user/files/${fullFilename}`;
    }

    /**
     * Extracts the original asset name from a full filename
     * @param {string} fullFilename - Full filename with prefix
     * @param {string} characterName - Character name
     * @returns {string} - Original asset name without extension
     */
    function extractAssetName(fullFilename, characterName) {
        const prefix = getCharacterFilePrefix(characterName);
        let name = fullFilename;
        if (name.startsWith(prefix)) {
            name = name.substring(prefix.length);
        }
        // Remove extension
        const lastDot = name.lastIndexOf('.');
        if (lastDot > 0) {
            name = name.substring(0, lastDot);
        }
        return name;
    }

    /**
     * Lists all image files for a character
     * Tries multiple storage locations:
     * 1. Flat structure in user/files/ (inline_assets__CharName__filename.png)
     * 2. Directory structure in user/images/{characterName}/
     * @param {string} characterName - Character name
     * @returns {Promise<Array>} - Array of file info objects
     */
    async function listCharacterImages(characterName) {
        const allAssets = [];
        const seenNames = new Set();
        
        try {
            const prefix = getCharacterFilePrefix(characterName);
            const sanitizedName = sanitizePathSegment(characterName);
            log(`Listing images for character "${characterName}" (sanitized: "${sanitizedName}") with prefix "${prefix}"`);

            // === APPROACH 0: SillyTavern Images API (/api/images/list) ===
            // Proper per-character folder listing under user/images/{characterName}/
            {
                const foldersToTry = [characterName];
                if (sanitizedName && sanitizedName !== characterName) foldersToTry.push(sanitizedName);

                for (const folder of foldersToTry) {
                    try {
                        let headers = await getApiHeaders();
                        let response = await fetch('/api/images/list', {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({
                                folder,
                                sortField: 'date',
                                sortOrder: 'desc',
                            }),
                        });

                        if (response.status === 403) {
                            log('[InlineImageAssets] Got 403 on /api/images/list, refreshing CSRF token and retrying...');
                            invalidateCsrfToken();
                            csrfDisabled = false;
                            headers = await getApiHeaders();
                            response = await fetch('/api/images/list', {
                                method: 'POST',
                                headers,
                                body: JSON.stringify({
                                    folder,
                                    sortField: 'date',
                                    sortOrder: 'desc',
                                }),
                            });
                        }

                        if (response.status === 404) {
                            // Images API not available on this server.
                            break;
                        }

                        if (response.ok) {
                            const result = await response.json();
                            if (Array.isArray(result) && result.length > 0) {
                                log(`Images API list found for folder "${folder}", count: ${result.length}`);

                                result.forEach((item) => {
                                    const src = (item && (item.src || item.url || item.path)) || item;
                                    let fileName = item && (item.name || item.filename);
                                    if ((!fileName || typeof fileName !== 'string') && typeof src === 'string') {
                                        fileName = src.split('/').pop();
                                    }
                                    if (!fileName || typeof fileName !== 'string') return;

                                    const ext = fileName.split('.').pop()?.toLowerCase();
                                    if (!SUPPORTED_FORMATS.includes(ext)) return;

                                    const assetName = fileName.substring(0, fileName.lastIndexOf('.'));
                                    if (seenNames.has(assetName)) return;
                                    seenNames.add(assetName);

                                    const url = (typeof src === 'string' && src.startsWith('/'))
                                        ? src
                                        : `/user/images/${folder}/${fileName}`;

                                    allAssets.push({
                                        name: assetName,
                                        filename: fileName,
                                        path: url,
                                        url,
                                        size: item && item.size,
                                        modified: item && (item.modified || item.mtime),
                                        isImageDir: true,
                                    });
                                });

                                break;
                            }
                        }
                    } catch (e) {
                        log(`Images API list error for folder "${folder}": ${e.message}`);
                    }
                }
            }
            
            // === APPROACH 1: Flat structure in user/files/ ===
            let flatFiles = [];
            const flatPathsToTry = ['', '/'];
            
            for (const path of flatPathsToTry) {
                try {
                    const apiUrl = `/api/files/list?path=${encodeURIComponent(path)}`;
                    log(`Trying flat API: ${apiUrl}`);
                    const response = await fetch(apiUrl);
                    if (response.ok) {
                        const result = await response.json();
                        if (Array.isArray(result) && result.length > 0) {
                            flatFiles = result;
                            log(`Flat file list found, count: ${flatFiles.length}`);
                            break;
                        }
                    }
                } catch (e) {
                    log(`Error fetching flat path "${path}":`, e.message);
                }
            }
            
            // Filter and add flat structure files
            if (flatFiles.length > 0) {
                const filtered = flatFiles.filter(file => {
                    const fileName = file.name || file;
                    if (typeof fileName !== 'string') return false;
                    if (!fileName.startsWith(prefix)) return false;
                    const ext = fileName.split('.').pop()?.toLowerCase();
                    return SUPPORTED_FORMATS.includes(ext);
                });
                
                log(`Filtered ${filtered.length} flat files for character ${characterName}`);
                
                filtered.forEach(file => {
                    const fileName = file.name || file;
                    const assetName = extractAssetName(fileName, characterName);
                    if (!seenNames.has(assetName)) {
                        seenNames.add(assetName);
                        allAssets.push({
                            name: assetName,
                            filename: fileName,
                            path: fileName,
                            url: `/user/files/${fileName}`,
                            size: file.size,
                            modified: file.modified
                        });
                    }
                });
            }
            
            // === APPROACH 2: Directory structure in user/images/{characterName}/ ===
            // Note: SillyTavern's /api/files/list doesn't support user/images/ path
            // We need to use a different approach - try direct URL access or use assets API
            
            // Try the assets API which might list character assets
            const assetApiPaths = [
                `/api/assets/character/${encodeURIComponent(characterName)}`,
                `/api/assets/character/${encodeURIComponent(sanitizedName)}`,
            ];
            
            for (const apiPath of assetApiPaths) {
                try {
                    log(`Trying assets API: ${apiPath}`);
                    const response = await fetch(apiPath);
                    if (response.ok) {
                        const result = await response.json();
                        log(`Assets API response:`, result);
                        
                        // Process assets if found
                        if (Array.isArray(result) && result.length > 0) {
                            result.forEach(asset => {
                                const fileName = asset.name || asset.filename || asset;
                                if (typeof fileName !== 'string') return;
                                const ext = fileName.split('.').pop()?.toLowerCase();
                                if (!SUPPORTED_FORMATS.includes(ext)) return;
                                
                                const assetName = fileName.substring(0, fileName.lastIndexOf('.'));
                                if (!seenNames.has(assetName)) {
                                    seenNames.add(assetName);
                                    allAssets.push({
                                        name: assetName,
                                        filename: fileName,
                                        path: asset.path || fileName,
                                        url: asset.url || `/user/images/${characterName}/${fileName}`,
                                        size: asset.size,
                                        modified: asset.modified,
                                        isImageDir: true
                                    });
                                    log(`Added asset from API: ${assetName}`);
                                }
                            });
                            break;
                        }
                    }
                } catch (e) {
                    log(`Assets API not available: ${e.message}`);
                }
            }
            
            // === APPROACH 3: Try direct directory listing via different endpoints ===
            // Some SillyTavern versions might support these
            const altDirPaths = [
                { api: `/api/files/list?folder=images/${characterName}`, urlBase: `/user/images/${characterName}` },
                { api: `/api/files/list?folder=images/${sanitizedName}`, urlBase: `/user/images/${sanitizedName}` },
                { api: `/api/files/list?directory=images/${characterName}`, urlBase: `/user/images/${characterName}` },
            ];
            
            for (const { api, urlBase } of altDirPaths) {
                try {
                    log(`Trying alt dir API: ${api}`);
                    const response = await fetch(api);
                    if (response.ok) {
                        const result = await response.json();
                        if (Array.isArray(result) && result.length > 0) {
                            log(`Found ${result.length} files via alt API`);
                            
                            result.forEach(file => {
                                const fileName = file.name || file;
                                if (typeof fileName !== 'string') return;
                                const ext = fileName.split('.').pop()?.toLowerCase();
                                if (!SUPPORTED_FORMATS.includes(ext)) return;
                                
                                const assetName = fileName.substring(0, fileName.lastIndexOf('.'));
                                if (!seenNames.has(assetName)) {
                                    seenNames.add(assetName);
                                    allAssets.push({
                                        name: assetName,
                                        filename: fileName,
                                        path: `${urlBase}/${fileName}`,
                                        url: `${urlBase}/${fileName}`,
                                        size: file.size,
                                        modified: file.modified,
                                        isImageDir: true
                                    });
                                    log(`Added from alt API: ${assetName} -> ${urlBase}/${fileName}`);
                                }
                            });
                            break;
                        }
                    }
                } catch (e) {
                    log(`Alt dir API error: ${e.message}`);
                }
            }
            
            log(`Total assets found: ${allAssets.length}`);
            
            if (allAssets.length > 0) {
                return allAssets;
            }
            
            // Fallback: try to get from extension field metadata
            log('No files found via API, falling back to metadata');
            return await getAssetsFromMetadata(characterName);
        } catch (error) {
            console.error('[InlineImageAssets] Failed to list images:', error);
            return await getAssetsFromMetadata(characterName);
        }
    }

    /**
     * Lists all image files for a persona
     * Uses flat structure in user/files/ (inline_assets__persona__PersonaName__filename.png)
     * @param {string} personaName - Persona name
     * @returns {Promise<Array>} - Array of file info objects
     */
    async function listPersonaImages(personaName) {
        const allAssets = [];
        const seenNames = new Set();
        
        try {
            const prefix = getPersonaFilePrefix(personaName);
            const sanitizedName = sanitizePathSegment(personaName);
            log(`Listing images for persona "${personaName}" (sanitized: "${sanitizedName}") with prefix "${prefix}"`);
            
            // Flat structure in user/files/
            let flatFiles = [];
            const flatPathsToTry = ['', '/'];
            
            for (const path of flatPathsToTry) {
                try {
                    const apiUrl = `/api/files/list?path=${encodeURIComponent(path)}`;
                    log(`Trying flat API for persona: ${apiUrl}`);
                    const response = await fetch(apiUrl);
                    if (response.ok) {
                        const result = await response.json();
                        if (Array.isArray(result) && result.length > 0) {
                            flatFiles = result;
                            log(`Flat file list found for persona, count: ${flatFiles.length}`);
                            break;
                        }
                    }
                } catch (e) {
                    log(`Error fetching flat path for persona "${path}":`, e.message);
                }
            }
            
            // Filter and add flat structure files
            if (flatFiles.length > 0) {
                const filtered = flatFiles.filter(file => {
                    const fileName = file.name || file;
                    if (typeof fileName !== 'string') return false;
                    if (!fileName.startsWith(prefix)) return false;
                    const ext = fileName.split('.').pop()?.toLowerCase();
                    return SUPPORTED_FORMATS.includes(ext);
                });
                
                log(`Filtered ${filtered.length} flat files for persona ${personaName}`);
                
                filtered.forEach(file => {
                    const fileName = file.name || file;
                    const assetName = extractPersonaAssetName(fileName, personaName);
                    if (!seenNames.has(assetName)) {
                        seenNames.add(assetName);
                        allAssets.push({
                            name: assetName,
                            filename: fileName,
                            path: fileName,
                            url: `/user/files/${fileName}`,
                            size: file.size,
                            modified: file.modified
                        });
                    }
                });
            }
            
            log(`Total persona assets found: ${allAssets.length}`);
            return allAssets;
        } catch (error) {
            console.error('[InlineImageAssets] Failed to list persona images:', error);
            return [];
        }
    }

    /**
     * Gets asset metadata from character extension field (fallback)
     * @param {string} characterName - Character name
     * @returns {Promise<Array>} - Array of asset info
     */
    async function getAssetsFromMetadata(characterName) {
        const context = getContext();
        const character = context.characters?.find(c => c.name === characterName);
        if (!character) return [];
        
        // Check for new file-based metadata
        const fileAssets = character.data?.extensions?.inline_image_assets || [];
        if (fileAssets.length > 0) {
            return fileAssets.map(asset => ({
                name: asset.name,
                filename: asset.filename,
                path: asset.path || asset.filename,
                url: asset.url || getAssetUrl(characterName, asset.filename),
                tags: asset.tags || []
            }));
        }
        
        // Check for legacy base64 data (for migration)
        const legacyAssets = character.data?.extensions?.inline_image_assets_b64 || [];
        if (legacyAssets.length > 0) {
            return legacyAssets.map(asset => ({
                name: asset.name,
                filename: null,
                data: asset.data, // base64 data for migration
                tags: asset.tags || [],
                isLegacy: true
            }));
        }
        
        return [];
    }

    /**
     * Converts a Blob/File to base64 string
     * @param {Blob|File} blob - Blob or File to convert
     * @returns {Promise<string>} - Base64 encoded string (without data URL prefix)
     */
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // Remove the data URL prefix (e.g., "data:image/png;base64,")
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Saves an image file for a character (flat structure, no slashes)
     * @param {string} characterName - Character name
     * @param {string} filename - Filename to save as
     * @param {Blob|File} imageData - Image data
     * @returns {Promise<Object>} - Saved file info
     */
    async function saveImageFile(characterName, filename, imageData) {
        try {
            // Prefer per-character folder storage via /api/images/upload
            const { baseName, format, fullFilename } = getImageNameAndFormat(filename, imageData?.type);

            const base64Data = await blobToBase64(imageData);
            log('Uploading to /api/images/upload:', { characterName, fullFilename, format, dataLength: base64Data.length });

            const headers = await getApiHeaders();

            let response = await fetch('/api/images/upload', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    image: base64Data,
                    ch_name: characterName,
                    filename: baseName,
                    format: format
                })
            });

            if (!response.ok && response.status === 403) {
                console.log('[InlineImageAssets] Got 403 on /api/images/upload, refreshing CSRF token and retrying...');
                invalidateCsrfToken();
                csrfDisabled = false;
                const newHeaders = await getApiHeaders();
                response = await fetch('/api/images/upload', {
                    method: 'POST',
                    headers: newHeaders,
                    body: JSON.stringify({
                        image: base64Data,
                        ch_name: characterName,
                        filename: baseName,
                        format: format
                    })
                });
            }

            // Fallback: if images API doesn't exist on this server, fall back to legacy /api/files/upload
            if (!response.ok && response.status === 404) {
                log('Images API not found (404). Falling back to /api/files/upload flat structure');
                const sanitizedFilename = sanitizePathSegment(filename);
                const prefix = getCharacterFilePrefix(characterName);
                const legacyFullFilename = sanitizedFilename.startsWith(IMAGE_PREFIX)
                    ? sanitizedFilename
                    : getAssetFullFilename(characterName, sanitizedFilename);

                const legacyHeaders = await getApiHeaders();
                let legacyResponse = await fetch('/api/files/upload', {
                    method: 'POST',
                    headers: legacyHeaders,
                    body: JSON.stringify({
                        name: legacyFullFilename,
                        data: base64Data
                    })
                });

                if (!legacyResponse.ok && legacyResponse.status === 403) {
                    invalidateCsrfToken();
                    csrfDisabled = false;
                    const retryHeaders = await getApiHeaders();
                    legacyResponse = await fetch('/api/files/upload', {
                        method: 'POST',
                        headers: retryHeaders,
                        body: JSON.stringify({
                            name: legacyFullFilename,
                            data: base64Data
                        })
                    });
                }

                if (!legacyResponse.ok) {
                    const errorText = await legacyResponse.text();
                    throw new Error(`Upload failed: ${legacyResponse.status} ${errorText}`);
                }

                const displayName = extractAssetName(legacyFullFilename, characterName);
                return {
                    name: displayName,
                    filename: legacyFullFilename,
                    path: legacyFullFilename,
                    url: `/user/files/${legacyFullFilename}`
                };
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Upload failed: ${response.status} ${errorText}`);
            }

            // Construct URL for user/images
            const url = `/user/images/${characterName}/${fullFilename}`;
            const path = `user/images/${characterName}/${fullFilename}`;

            return {
                name: baseName,
                filename: fullFilename,
                path: path,
                url: url,
                isImageDir: true
            };
        } catch (error) {
            console.error('[InlineImageAssets] Failed to save image:', error);
            throw error;
        }
    }

    /**
     * Saves an image file for a persona (flat structure, no slashes)
     * @param {string} personaName - Persona name
     * @param {string} filename - Filename to save as
     * @param {Blob|File} imageData - Image data
     * @returns {Promise<Object>} - Saved file info
     */
    async function savePersonaImageFile(personaName, filename, imageData) {
        try {
            // Sanitize the filename first
            const sanitizedFilename = sanitizePathSegment(filename);
            
            // Check if filename already has our prefix to avoid double-prefixing
            const prefix = getPersonaFilePrefix(personaName);
            let fullFilename;
            if (sanitizedFilename.startsWith(PERSONA_PREFIX)) {
                // Already has prefix, use as-is
                fullFilename = sanitizedFilename;
                log('Persona filename already has prefix, using as-is:', fullFilename);
            } else {
                // Add prefix
                fullFilename = getPersonaAssetFullFilename(personaName, sanitizedFilename);
                log('Added prefix to persona filename:', fullFilename);
            }
            
            // Convert blob to base64
            const base64Data = await blobToBase64(imageData);
            
            console.log('[InlineImageAssets] Uploading persona asset:', fullFilename);
            log('Blob type:', imageData.type, 'size:', imageData.size);
            
            // Get headers with CSRF token (async)
            const headers = await getApiHeaders();
            
            const response = await fetch('/api/files/upload', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    name: fullFilename,
                    data: base64Data
                })
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[InlineImageAssets] Persona upload response:', response.status, errorText);
                
                // If forbidden, try to refresh CSRF token and retry once
                if (response.status === 403) {
                    console.log('[InlineImageAssets] Got 403, refreshing CSRF token and retrying...');
                    invalidateCsrfToken();
                    csrfDisabled = false;
                    const newHeaders = await getApiHeaders();
                    
                    const retryResponse = await fetch('/api/files/upload', {
                        method: 'POST',
                        headers: newHeaders,
                        body: JSON.stringify({
                            name: fullFilename,
                            data: base64Data
                        })
                    });
                    
                    if (!retryResponse.ok) {
                        const retryErrorText = await retryResponse.text();
                        throw new Error(`Upload failed after retry: ${retryResponse.status} ${retryErrorText}`);
                    }
                    
                    const displayName = extractPersonaAssetName(fullFilename, personaName);
                    const fileUrl = `/user/files/${fullFilename}`;
                    
                    return {
                        name: displayName,
                        filename: fullFilename,
                        path: fullFilename,
                        url: fileUrl
                    };
                }
                
                throw new Error(`Upload failed: ${response.status} ${errorText}`);
            }
            
            const result = await response.json();
            console.log('[InlineImageAssets] Persona upload result:', result);
            
            const displayName = extractPersonaAssetName(fullFilename, personaName);
            const fileUrl = `/user/files/${fullFilename}`;
            
            return {
                name: displayName,
                filename: fullFilename,
                path: fullFilename,
                url: fileUrl
            };
        } catch (error) {
            console.error('[InlineImageAssets] Failed to save persona image:', error);
            throw error;
        }
    }

    /**
     * Deletes a persona image file (flat structure)
     * @param {string} personaName - Persona name
     * @param {string} filename - Full filename (with prefix) to delete
     * @returns {Promise<boolean>} - Success status
     */
    async function deletePersonaImageFile(personaName, filename) {
        try {
            const prefix = getPersonaFilePrefix(personaName);
            const fullFilename = filename.startsWith(prefix) ? filename : getPersonaAssetFullFilename(personaName, filename);
            
            log('Deleting persona file:', fullFilename);
            
            const headers = await getApiHeaders();
            
            const pathsToTry = [
                fullFilename,
                `files/${fullFilename}`,
                `/files/${fullFilename}`,
            ];
            
            for (const deletePath of pathsToTry) {
                const response = await fetch('/api/files/delete', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ path: deletePath })
                });
                
                if (response.ok) {
                    log('Persona delete successful with path:', deletePath);
                    return true;
                }
                
                if (response.status === 403) {
                    invalidateCsrfToken();
                    csrfDisabled = false;
                    const newHeaders = await getApiHeaders();
                    
                    const retryResponse = await fetch('/api/files/delete', {
                        method: 'POST',
                        headers: newHeaders,
                        body: JSON.stringify({ path: deletePath })
                    });
                    
                    if (retryResponse.ok) {
                        return true;
                    }
                }
            }
            
            console.warn('[InlineImageAssets] Persona delete failed with all path formats');
            return false;
        } catch (error) {
            console.error('[InlineImageAssets] Failed to delete persona image:', error);
            return false;
        }
    }

    /**
     * Deletes an image file (flat structure)
     * @param {string} characterName - Character name
     * @param {string} filename - Full filename (with prefix) to delete
     * @returns {Promise<boolean>} - Success status
     */
    async function deleteImageFile(characterName, assetOrFilename) {
        try {
            const asset = (assetOrFilename && typeof assetOrFilename === 'object') ? assetOrFilename : null;
            const filename = asset ? asset.filename : assetOrFilename;
            const candidatePath = asset ? (asset.path || asset.url || '') : '';
            const isImageDir = !!(asset && asset.isImageDir) || (typeof candidatePath === 'string' && candidatePath.includes('user/images/'));

            // Delete from user/images via /api/images/delete when applicable
            if (isImageDir) {
                const headers = await getApiHeaders();
                let deletePath = candidatePath;

                if (!deletePath && typeof filename === 'string') {
                    deletePath = `user/images/${characterName}/${filename}`;
                }

                if (typeof deletePath === 'string') {
                    deletePath = deletePath.replace(/^\/+/, '');
                }

                log('Deleting image via /api/images/delete:', deletePath);
                let response = await fetch('/api/images/delete', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ path: deletePath })
                });

                if (!response.ok && response.status === 403) {
                    invalidateCsrfToken();
                    csrfDisabled = false;
                    const newHeaders = await getApiHeaders();
                    response = await fetch('/api/images/delete', {
                        method: 'POST',
                        headers: newHeaders,
                        body: JSON.stringify({ path: deletePath })
                    });
                }

                if (response.ok) {
                    return true;
                }

                const errorText = await response.text().catch(() => '');
                log('Image delete failed:', response.status, errorText);
                // Fall through to try legacy delete if needed
            }

            // Legacy delete in user/files
            const prefix = getCharacterFilePrefix(characterName);
            const fullFilename = (typeof filename === 'string' && filename.startsWith(prefix))
                ? filename
                : getAssetFullFilename(characterName, filename);

            log('Deleting legacy file via /api/files/delete:', fullFilename);

            const headers = await getApiHeaders();
            const pathsToTry = [
                fullFilename,
                `files/${fullFilename}`,
                `/files/${fullFilename}`,
            ];

            for (const deletePath of pathsToTry) {
                const response = await fetch('/api/files/delete', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ path: deletePath })
                });

                if (response.ok) {
                    return true;
                }

                if (response.status === 403) {
                    invalidateCsrfToken();
                    csrfDisabled = false;
                    const newHeaders = await getApiHeaders();
                    const retryResponse = await fetch('/api/files/delete', {
                        method: 'POST',
                        headers: newHeaders,
                        body: JSON.stringify({ path: deletePath })
                    });
                    if (retryResponse.ok) {
                        return true;
                    }
                }
            }

            return false;
        } catch (error) {
            console.error('[InlineImageAssets] Failed to delete image:', error);
            return false;
        }
    }

    /**
     * Deletes multiple image files
     * @param {string} characterName - Character name
     * @param {Array<string>} filenames - Array of filenames to delete
     * @returns {Promise<Object>} - Results with success/failure counts
     */
    async function deleteMultipleImages(characterName, assetsOrFilenames) {
        const results = { success: 0, failed: 0 };

        for (const item of assetsOrFilenames) {
            const success = await deleteImageFile(characterName, item);
            if (success) {
                results.success++;
            } else {
                results.failed++;
            }
        }
        
        return results;
    }

    /**
     * Validates if a file is a supported image format
     * @param {File} file - File to validate
     * @returns {Object} - { valid: boolean, reason?: string }
     */
    function validateImageFile(file) {
        // File size limit (10MB)
        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        
        if (file.size > MAX_FILE_SIZE) {
            return {
                valid: false,
                reason: `File size is too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`
            };
        }
        
        // Extension check
        const fileName = file.name.toLowerCase();
        const extension = fileName.split('.').pop();
        
        // SUPPORTED_FORMATS already includes webp
        if (!SUPPORTED_FORMATS.includes(extension)) {
            return {
                valid: false,
                reason: `Unsupported file format: .${extension}. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`
            };
        }
        
        // MIME type check (additional safety measure)
        // Allow empty MIME type (some browsers may have empty MIME type for webp, etc.)
        const validMimeTypes = [
            'image/png', 'image/jpeg', 'image/jpg', 'image/gif',
            'image/webp', 'image/bmp', 'image/svg+xml', ''
        ];
        
        // Reject if MIME type exists and doesn't start with image/
        // However, allow empty MIME type since it passed extension check
        if (file.type && file.type !== '' && !file.type.startsWith('image/')) {
            return {
                valid: false,
                reason: `Not an image file: ${file.type}`
            };
        }
        
        return { valid: true };
    }

    /**
     * Converts base64 data to Blob
     * @param {string} base64Data - Base64 encoded image data
     * @returns {Blob} - Image blob
     */
    function base64ToBlob(base64Data) {
        const parts = base64Data.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/png';
        const byteString = atob(parts[1]);
        const arrayBuffer = new ArrayBuffer(byteString.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        
        for (let i = 0; i < byteString.length; i++) {
            uint8Array[i] = byteString.charCodeAt(i);
        }
        
        return new Blob([uint8Array], { type: mime });
    }

    /**
     * Gets file extension from MIME type
     * @param {string} mimeType - MIME type
     * @returns {string} - File extension
     */
    function getExtensionFromMime(mimeType) {
        const mimeMap = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
            'image/svg+xml': 'svg'
        };
        return mimeMap[mimeType] || 'png';
    }

    /**
     * Migrates legacy base64 assets to file system
     * @param {string} characterName - Character name
     * @param {Array} legacyAssets - Array of legacy base64 assets
     * @returns {Promise<Array>} - Array of migrated asset info
     */
    async function migrateLegacyAssets(characterName, legacyAssets) {
        const migratedAssets = [];
        let successCount = 0;
        let failCount = 0;
        
        toastr.info(`Migrating ${legacyAssets.length} legacy assets to file system...`);
        log('Starting migration for', legacyAssets.length, 'assets');
        
        for (const asset of legacyAssets) {
            try {
                if (!asset.data) {
                    log('Skipping asset without data:', asset.name);
                    continue;
                }
                
                log('Migrating asset:', asset.name);
                
                const blob = base64ToBlob(asset.data);
                const ext = getExtensionFromMime(blob.type);
                // Use the original asset name (sanitized) for the filename
                const sanitizedName = sanitizeFilename(asset.name);
                const filename = `${sanitizedName}.${ext}`;
                
                log('Saving file:', filename, 'blob size:', blob.size);
                
                const savedFile = await saveImageFile(characterName, filename, blob);
                
                log('File saved successfully:', savedFile);
                
                // Ensure URL is properly constructed
                const fileUrl = savedFile.url || `/user/files/${savedFile.filename}`;
                
                migratedAssets.push({
                    name: asset.name, // Keep original name for %%img:name%% matching
                    filename: savedFile.filename,
                    path: savedFile.path,
                    url: fileUrl,
                    tags: asset.tags || []
                });
                
                successCount++;
                log(`Migrated asset "${asset.name}" -> URL: ${fileUrl}`);
            } catch (error) {
                console.error(`[InlineImageAssets] Failed to migrate asset ${asset.name}:`, error);
                log('Migration failed for:', asset.name, 'error:', error.message);
                failCount++;
            }
        }
        
        log('Migration complete. Success:', successCount, 'Failed:', failCount);
        log('Migrated assets:', JSON.stringify(migratedAssets, null, 2));
        
        if (successCount > 0) {
            toastr.success(`Successfully migrated ${successCount} assets`);
            // Invalidate cache to force rebuild with new URLs
            invalidateAssetCache();
        }
        if (failCount > 0) {
            toastr.warning(`Failed to migrate ${failCount} assets`);
        }
        
        return migratedAssets;
    }

    /**
     * Migrates legacy flat user/files assets to user/images/{characterName}/
     * This requires SillyTavern's Images API (/api/images/upload).
     * @param {string} characterName - Character name
     * @param {Array} legacyFileAssets - Optional array of legacy file assets (from listCharacterImages)
     * @returns {Promise<Array>} - Array of migrated asset info
     */
    async function migrateFilesToCharacterFolder(characterName, legacyFileAssets = null) {
        const migratedAssets = [];
        let successCount = 0;
        let failCount = 0;

        const prefix = getCharacterFilePrefix(characterName);

        // If not provided, list legacy files now
        let legacyFiles = legacyFileAssets;
        if (!Array.isArray(legacyFiles)) {
            legacyFiles = [];
            const flatPathsToTry = ['', '/'];
            for (const path of flatPathsToTry) {
                try {
                    const apiUrl = `/api/files/list?path=${encodeURIComponent(path)}`;
                    const response = await fetch(apiUrl);
                    if (response.ok) {
                        const result = await response.json();
                        if (Array.isArray(result) && result.length > 0) {
                            legacyFiles = result;
                            break;
                        }
                    }
                } catch (e) {
                    // ignore
                }
            }
        }

        // Normalize to filenames
        // IMPORTANT: legacyFileAssets from listCharacterImages() are objects where:
        // - f.name is the asset display name (no extension, no prefix)
        // - f.filename is the real filename in user/files (includes prefix + extension)
        // So we must prefer filename first.
        const legacyFilenames = legacyFiles
            .map((f) => (f && (f.filename || f.name)) || f)
            .filter((name) => typeof name === 'string')
            .filter((name) => name.startsWith(prefix))
            .filter((name) => {
                const ext = name.split('.').pop()?.toLowerCase();
                return SUPPORTED_FORMATS.includes(ext);
            });

        if (legacyFilenames.length === 0) {
            toastr.info('No legacy user/files assets found to migrate.');
            return [];
        }

        toastr.info(`Migrating ${legacyFilenames.length} user/files assets to user/images/${characterName}/...`);
        log('Starting files->images migration for', legacyFilenames.length, 'files');

        for (const legacyFilename of legacyFilenames) {
            try {
                const assetName = extractAssetName(legacyFilename, characterName);
                const ext = legacyFilename.split('.').pop()?.toLowerCase() || 'png';
                const downloadUrl = `/user/files/${legacyFilename}`;

                const response = await fetch(downloadUrl);
                if (!response.ok) {
                    throw new Error(`Failed to download legacy file (${response.status})`);
                }

                const blob = await response.blob();

                // Upload with clean per-asset filename (avoid including our legacy prefix)
                const uploaded = await saveImageFile(characterName, `${assetName}.${ext}`, blob);

                // Delete legacy file after successful upload
                await deleteImageFile(characterName, legacyFilename);

                migratedAssets.push({
                    name: assetName,
                    filename: uploaded.filename,
                    path: uploaded.path,
                    url: uploaded.url,
                    tags: [],
                    isImageDir: true,
                });
                successCount++;
            } catch (error) {
                console.error(`[InlineImageAssets] Failed to migrate legacy file ${legacyFilename}:`, error);
                failCount++;
            }
        }

        if (successCount > 0) {
            toastr.success(`Successfully migrated ${successCount} files to user/images/${characterName}/`);
            invalidateAssetCache();
        }
        if (failCount > 0) {
            toastr.warning(`Failed to migrate ${failCount} files`);
        }

        return migratedAssets;
    }

    // === CHARX ASSET DETECTION ===
    
    /**
     * Checks for and loads charx extracted assets
     * Note: Charx assets are in subdirectories, so we need different handling
     * @param {string} characterName - Character name (can include unicode characters)
     * @returns {Promise<Array>} - Array of charx assets
     */
    async function loadCharxAssets(characterName) {
        try {
            // Check common charx extraction paths
            // Note: These are actual directory paths, not our flat structure
            const sanitizedName = sanitizePathSegment(characterName);
            
            // CharX assets are typically extracted to characters/CharName/assets/ or similar
            // SillyTavern serves character assets from /characters/CharName/
            // Try both original name (for unicode support) and sanitized name
            const possiblePaths = [
                // Original name paths (supports unicode like Ryūnosuke)
                { apiPath: `characters/${characterName}/assets`, urlBase: `/characters/${characterName}/assets` },
                { apiPath: `characters/${characterName}/images`, urlBase: `/characters/${characterName}/images` },
                { apiPath: `characters/${characterName}`, urlBase: `/characters/${characterName}` },
                // Sanitized name paths (fallback)
                { apiPath: `characters/${sanitizedName}/assets`, urlBase: `/characters/${sanitizedName}/assets` },
                { apiPath: `characters/${sanitizedName}/images`, urlBase: `/characters/${sanitizedName}/images` },
                { apiPath: `characters/${sanitizedName}`, urlBase: `/characters/${sanitizedName}` }
            ];
            
            // Remove duplicates (in case sanitizedName === characterName)
            const uniquePaths = possiblePaths.filter((path, index, self) =>
                index === self.findIndex(p => p.apiPath === path.apiPath)
            );
            
            for (const { apiPath, urlBase } of uniquePaths) {
                try {
                    log(`Checking charx path: ${apiPath}`);
                    const response = await fetch(`/api/files/list?path=${encodeURIComponent(apiPath)}`);
                    
                    if (response.ok) {
                        const files = await response.json();
                        log(`Files found in ${apiPath}:`, files.length);
                        
                        const imageFiles = files.filter(file => {
                            const fileName = typeof file === 'string' ? file : file.name;
                            if (!fileName) return false;
                            const ext = fileName.split('.').pop()?.toLowerCase();
                            return SUPPORTED_FORMATS.includes(ext);
                        });
                        
                        if (imageFiles.length > 0) {
                            log(`Found ${imageFiles.length} charx assets in ${apiPath}`);
                            return imageFiles.map(file => {
                                const fileName = typeof file === 'string' ? file : file.name;
                                return {
                                    name: fileName.substring(0, fileName.lastIndexOf('.')),
                                    filename: fileName,
                                    path: `${apiPath}/${fileName}`,
                                    url: `${urlBase}/${fileName}`,
                                    isCharxAsset: true
                                };
                            });
                        }
                    } else {
                        log(`Path ${apiPath} returned:`, response.status);
                    }
                } catch (e) {
                    log(`Error checking path ${apiPath}:`, e.message);
                    // Path doesn't exist, continue to next
                }
            }
            
            log('No charx assets found');
            return [];
        } catch (error) {
            console.error('[InlineImageAssets] Failed to load charx assets:', error);
            return [];
        }
    }

    /**
     * Shows a dialog for manual asset registration
     * @param {Object} character - Character object
     * @param {Object} context - SillyTavern context
     * @param {HTMLElement} container - Popup container for refresh
     */
    async function showManualAssetDialog(character, context, container) {
        return new Promise((resolve) => {
            const dialog = document.createElement('div');
            dialog.className = 'inline-assets-manual-dialog';
            dialog.innerHTML = `
                <div class="inline-assets-manual-dialog-content">
                    <h4>Register Image Asset</h4>
                    <p>Enter the image details:</p>
                    
                    <div class="manual-asset-form">
                        <div class="form-group">
                            <label>Base Path:</label>
                            <select id="manual-base-path">
                                <option value="/user/images/${character.name}">/user/images/${character.name}/</option>
                                <option value="/user/images/${sanitizePathSegment(character.name)}">/user/images/${sanitizePathSegment(character.name)}/</option>
                                <option value="/characters/${character.name}">/characters/${character.name}/</option>
                                <option value="custom">Custom path...</option>
                            </select>
                            <input type="text" id="manual-custom-path" placeholder="/user/images/..." style="display: none; margin-top: 5px;">
                        </div>
                        
                        <div class="form-group">
                            <label>Filenames (one per line, or comma-separated):</label>
                            <textarea id="manual-filenames" rows="5" placeholder="smile.png&#10;happy.png&#10;angry.png"></textarea>
                        </div>
                        
                        <div class="form-group">
                            <label>
                                <input type="checkbox" id="manual-verify-urls" checked>
                                Verify URLs before adding
                            </label>
                        </div>
                    </div>
                    
                    <div class="dialog-buttons">
                        <button class="menu_button" id="manual-add-btn">
                            <i class="fa-solid fa-plus"></i> Add Assets
                        </button>
                        <button class="menu_button" id="manual-cancel-btn">Cancel</button>
                    </div>
                </div>
            `;
            
            // Add styles
            dialog.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            `;
            
            const content = dialog.querySelector('.inline-assets-manual-dialog-content');
            content.style.cssText = `
                background: var(--SmartThemeBlurTintColor, #1a1a1a);
                padding: 20px;
                border-radius: 10px;
                min-width: 400px;
                max-width: 500px;
            `;
            
            const formGroups = dialog.querySelectorAll('.form-group');
            formGroups.forEach(fg => {
                fg.style.cssText = 'margin-bottom: 15px;';
                const label = fg.querySelector('label');
                if (label) label.style.cssText = 'display: block; margin-bottom: 5px;';
            });
            
            const textarea = dialog.querySelector('textarea');
            textarea.style.cssText = 'width: 100%; padding: 8px; border-radius: 5px; background: var(--SmartThemeBodyColor, #333); color: var(--SmartThemeTextColor, #fff); border: 1px solid var(--SmartThemeBorderColor, #555);';
            
            const select = dialog.querySelector('select');
            select.style.cssText = 'width: 100%; padding: 8px; border-radius: 5px; background: var(--SmartThemeBodyColor, #333); color: var(--SmartThemeTextColor, #fff); border: 1px solid var(--SmartThemeBorderColor, #555);';
            
            const customInput = dialog.querySelector('#manual-custom-path');
            customInput.style.cssText = 'width: 100%; padding: 8px; border-radius: 5px; background: var(--SmartThemeBodyColor, #333); color: var(--SmartThemeTextColor, #fff); border: 1px solid var(--SmartThemeBorderColor, #555);';
            
            const buttons = dialog.querySelector('.dialog-buttons');
            buttons.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;';
            
            // Show/hide custom path input
            select.addEventListener('change', () => {
                customInput.style.display = select.value === 'custom' ? 'block' : 'none';
            });
            
            // Cancel button
            dialog.querySelector('#manual-cancel-btn').addEventListener('click', () => {
                dialog.remove();
                resolve();
            });
            
            // Add button
            dialog.querySelector('#manual-add-btn').addEventListener('click', async () => {
                const basePath = select.value === 'custom' ? customInput.value.trim() : select.value;
                const filenamesText = textarea.value.trim();
                const verifyUrls = dialog.querySelector('#manual-verify-urls').checked;
                
                if (!basePath) {
                    toastr.error('Please enter a base path');
                    return;
                }
                
                if (!filenamesText) {
                    toastr.error('Please enter at least one filename');
                    return;
                }
                
                // Parse filenames (support both newline and comma separation)
                const filenames = filenamesText
                    .split(/[\n,]/)
                    .map(f => f.trim())
                    .filter(f => f.length > 0);
                
                if (filenames.length === 0) {
                    toastr.error('No valid filenames found');
                    return;
                }
                
                const currentAssets = ContextUtil.getAssetsRaw(character);
                const existingNames = new Set(currentAssets.map(a => a.name));
                let addedCount = 0;
                let skippedCount = 0;
                let failedCount = 0;
                
                for (const filename of filenames) {
                    const assetName = filename.substring(0, filename.lastIndexOf('.')) || filename;
                    
                    if (existingNames.has(assetName)) {
                        skippedCount++;
                        continue;
                    }
                    
                    const fullUrl = basePath.endsWith('/') ? `${basePath}${filename}` : `${basePath}/${filename}`;
                    
                    // Verify URL if requested
                    if (verifyUrls) {
                        try {
                            const response = await fetch(fullUrl, { method: 'HEAD' });
                            if (!response.ok) {
                                log(`URL verification failed for ${fullUrl}: ${response.status}`);
                                failedCount++;
                                continue;
                            }
                        } catch (e) {
                            log(`URL verification error for ${fullUrl}: ${e.message}`);
                            failedCount++;
                            continue;
                        }
                    }
                    
                    currentAssets.push({
                        name: assetName,
                        filename: filename,
                        path: fullUrl,
                        url: fullUrl,
                        tags: [],
                        isManual: true
                    });
                    existingNames.add(assetName);
                    addedCount++;
                }
                
                if (addedCount > 0) {
                    await ContextUtil.saveAssets(context.characterId, currentAssets);
                    toastr.success(`Added ${addedCount} asset(s)`);
                }
                if (skippedCount > 0) {
                    toastr.info(`Skipped ${skippedCount} duplicate(s)`);
                }
                if (failedCount > 0) {
                    toastr.warning(`${failedCount} URL(s) failed verification`);
                }
                
                dialog.remove();
                
                if (addedCount > 0) {
                    await initializeAssetList(container, character);
                }
                
                resolve();
            });
            
            document.body.appendChild(dialog);
        });
    }

    /**
     * Shows a dialog to choose import method
     * @returns {Promise<string|null>} - 'charx', 'userImages', 'manual', or null if cancelled
     */
    async function showImportOptionsDialog() {
        return new Promise((resolve) => {
            const dialog = document.createElement('div');
            dialog.className = 'inline-assets-import-dialog';
            dialog.innerHTML = `
                <div class="inline-assets-import-dialog-content">
                    <h4>Import Assets</h4>
                    <p>Choose how to import assets:</p>
                    <div class="inline-assets-import-options">
                        <button class="menu_button" data-choice="charx">
                            <i class="fa-solid fa-file-import"></i>
                            Import from Charx
                        </button>
                        <button class="menu_button" data-choice="userImages">
                            <i class="fa-solid fa-folder-open"></i>
                            Scan user/images/ folder
                        </button>
                        <button class="menu_button" data-choice="manual">
                            <i class="fa-solid fa-link"></i>
                            Add manual URL
                        </button>
                    </div>
                    <button class="menu_button cancel-btn" data-choice="cancel">Cancel</button>
                </div>
            `;
            
            // Add styles
            dialog.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.7);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            `;
            
            const content = dialog.querySelector('.inline-assets-import-dialog-content');
            content.style.cssText = `
                background: var(--SmartThemeBlurTintColor, #1a1a1a);
                padding: 20px;
                border-radius: 10px;
                min-width: 300px;
                text-align: center;
            `;
            
            const options = dialog.querySelector('.inline-assets-import-options');
            options.style.cssText = `
                display: flex;
                flex-direction: column;
                gap: 10px;
                margin: 15px 0;
            `;
            
            dialog.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', () => {
                    const choice = btn.dataset.choice;
                    dialog.remove();
                    resolve(choice === 'cancel' ? null : choice);
                });
            });
            
            document.body.appendChild(dialog);
        });
    }

    /**
     * Scans user/images/{characterName}/ directory for images
     * Uses HEAD requests to test if images exist at known paths
     * Also tries to discover files by testing common patterns
     * @param {string} characterName - Character name
     * @param {Array<string>} knownNames - Optional array of known asset names to check
     * @returns {Promise<Array>} - Array of found assets
     */
    async function scanUserImagesDirectory(characterName, knownNames = []) {
        // Prefer SillyTavern Images API if available.
        // If it returns data, it's more reliable than the old HEAD-probing approach.
        try {
            const sanitizedName = sanitizePathSegment(characterName);
            const foldersToTry = [characterName];
            if (sanitizedName && sanitizedName !== characterName) foldersToTry.push(sanitizedName);

            for (const folder of foldersToTry) {
                let headers = await getApiHeaders();
                let response = await fetch('/api/images/list', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        folder,
                        sortField: 'date',
                        sortOrder: 'desc',
                    }),
                });

                if (response.status === 403) {
                    log('[InlineImageAssets] Got 403 on /api/images/list (scan), refreshing CSRF token and retrying...');
                    invalidateCsrfToken();
                    csrfDisabled = false;
                    headers = await getApiHeaders();
                    response = await fetch('/api/images/list', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            folder,
                            sortField: 'date',
                            sortOrder: 'desc',
                        }),
                    });
                }

                if (response.status === 404) {
                    // No images API on this server; fall back to probing.
                    break;
                }

                if (response.ok) {
                    const result = await response.json();
                    if (Array.isArray(result)) {
                        const assets = [];
                        result.forEach((item) => {
                            const src = (item && (item.src || item.url || item.path)) || item;
                            let fileName = item && (item.name || item.filename);
                            if ((!fileName || typeof fileName !== 'string') && typeof src === 'string') {
                                fileName = src.split('/').pop();
                            }
                            if (!fileName || typeof fileName !== 'string') return;

                            const ext = fileName.split('.').pop()?.toLowerCase();
                            if (!SUPPORTED_FORMATS.includes(ext)) return;

                            const assetName = fileName.substring(0, fileName.lastIndexOf('.'));
                            const url = (typeof src === 'string' && src.startsWith('/'))
                                ? src
                                : `/user/images/${folder}/${fileName}`;

                            assets.push({
                                name: assetName,
                                filename: fileName,
                                path: url,
                                url,
                                tags: [],
                                isImageDir: true,
                                size: item && item.size,
                                modified: item && (item.modified || item.mtime),
                            });
                        });

                        // If the API works, trust it (even if empty) to avoid expensive probing.
                        return assets;
                    }
                }
            }
        } catch (e) {
            log('Images API list failed during scan, falling back to probing:', e.message);
        }

        const foundAssets = [];
        const sanitizedName = sanitizePathSegment(characterName);
        const testedUrls = new Set();
        
        // Try different base paths - prioritize original name for unicode support
        const basePaths = [
            `/user/images/${characterName}`,
            `/user/images/${sanitizedName}`,
        ];
        
        // Remove duplicates
        const uniqueBasePaths = [...new Set(basePaths)];
        
        // Common image filenames to try
        const commonNames = new Set();
        
        // Add known names first (from existing assets)
        knownNames.forEach(name => {
            SUPPORTED_FORMATS.forEach(ext => {
                commonNames.add(`${name}.${ext}`);
            });
        });
        
        // Generate common expression names
        const expressions = [
            'smile', 'happy', 'sad', 'angry', 'surprised', 'neutral', 'blush', 'smirk',
            'worried', 'excited', 'shy', 'embarrassed', 'confused', 'thinking', 'crying',
            'laughing', 'serious', 'annoyed', 'scared', 'love', 'heart', 'wink',
            'default', 'normal', 'idle', 'talk', 'speaking'
        ];
        
        expressions.forEach(expr => {
            SUPPORTED_FORMATS.forEach(ext => {
                commonNames.add(`${expr}.${ext}`);
            });
        });
        
        // Also try numbered patterns and common naming conventions
        for (let i = 1; i <= 30; i++) {
            SUPPORTED_FORMATS.forEach(ext => {
                commonNames.add(`${i}.${ext}`);
                commonNames.add(`image${i}.${ext}`);
                commonNames.add(`img${i}.${ext}`);
                commonNames.add(`pic${i}.${ext}`);
                commonNames.add(`photo${i}.${ext}`);
            });
        }
        
        // Add alphabet-based patterns (a.png, b.png, etc.)
        'abcdefghijklmnopqrstuvwxyz'.split('').forEach(letter => {
            SUPPORTED_FORMATS.forEach(ext => {
                commonNames.add(`${letter}.${ext}`);
            });
        });
        
        log(`Scanning for images in user/images/ for character: ${characterName}`);
        log(`Testing ${commonNames.size} filename patterns across ${uniqueBasePaths.length} base paths`);
        
        // Helper function to test a URL
        async function testUrl(url) {
            if (testedUrls.has(url)) return null;
            testedUrls.add(url);
            
            try {
                const response = await fetch(url, { method: 'HEAD' });
                if (response.ok) {
                    return url;
                }
            } catch (e) {
                // Ignore errors
            }
            return null;
        }
        
        // Test each base path
        let workingBasePath = null;
        
        for (const basePath of uniqueBasePaths) {
            // Quick test with a few common filenames to find working base path
            const quickTestNames = ['1.png', 'default.png', 'smile.png', 'happy.png', 'normal.png'];
            
            for (const testName of quickTestNames) {
                const url = `${basePath}/${testName}`;
                const result = await testUrl(url);
                
                if (result) {
                    workingBasePath = basePath;
                    const assetName = testName.substring(0, testName.lastIndexOf('.'));
                    
                    foundAssets.push({
                        name: assetName,
                        filename: testName,
                        path: url,
                        url: url,
                        tags: [],
                        isImageDir: true
                    });
                    log(`Found image: ${url}`);
                    break;
                }
            }
            
            if (workingBasePath) break;
        }
        
        // If we found a working base path, test all common names
        if (workingBasePath) {
            log(`Found working base path: ${workingBasePath}`);
            
            // Test remaining filenames in parallel batches for speed
            const filenames = Array.from(commonNames);
            const batchSize = 10;
            
            for (let i = 0; i < filenames.length; i += batchSize) {
                const batch = filenames.slice(i, i + batchSize);
                const promises = batch.map(async (filename) => {
                    const url = `${workingBasePath}/${filename}`;
                    const result = await testUrl(url);
                    
                    if (result) {
                        const assetName = filename.substring(0, filename.lastIndexOf('.'));
                        
                        if (!foundAssets.some(a => a.name === assetName)) {
                            return {
                                name: assetName,
                                filename: filename,
                                path: url,
                                url: url,
                                tags: [],
                                isImageDir: true
                            };
                        }
                    }
                    return null;
                });
                
                const results = await Promise.all(promises);
                results.filter(Boolean).forEach(asset => {
                    foundAssets.push(asset);
                    log(`Found image: ${asset.url}`);
                });
            }
        } else {
            // No working base path found, try all paths with all names
            log('No working base path found, trying all combinations...');
            
            for (const basePath of uniqueBasePaths) {
                for (const filename of Array.from(commonNames).slice(0, 50)) { // Limit to first 50
                    const url = `${basePath}/${filename}`;
                    const result = await testUrl(url);
                    
                    if (result) {
                        const assetName = filename.substring(0, filename.lastIndexOf('.'));
                        
                        if (!foundAssets.some(a => a.name === assetName)) {
                            foundAssets.push({
                                name: assetName,
                                filename: filename,
                                path: url,
                                url: url,
                                tags: [],
                                isImageDir: true
                            });
                            log(`Found image: ${url}`);
                        }
                    }
                }
            }
        }
        
        log(`Scan complete. Found ${foundAssets.length} images`);
        return foundAssets;
    }

    /**
     * Imports charx assets to the character's image directory
     * @param {string} characterName - Character name
     * @param {Array} charxAssets - Array of charx asset info
     * @returns {Promise<Array>} - Array of imported asset info
     */
    async function importCharxAssets(characterName, charxAssets) {
        const importedAssets = [];
        
        for (const asset of charxAssets) {
            try {
                // Fetch the image from charx location
                const response = await fetch(asset.url);
                if (!response.ok) continue;
                
                const blob = await response.blob();
                const savedFile = await saveImageFile(characterName, asset.filename, blob);
                
                importedAssets.push({
                    name: asset.name,
                    filename: savedFile.filename,
                    path: savedFile.path,
                    url: savedFile.url,
                    tags: []
                });
            } catch (error) {
                console.error(`[InlineImageAssets] Failed to import charx asset ${asset.name}:`, error);
            }
        }
        
        return importedAssets;
    }

    // === CONTEXT UTILITIES ===
    
    class ContextUtil {
        static getCharacterFromData(message, context) {
            // Optimization: Don't search if user message
            if (message.is_user) return null;
            // Direct lookup if possible, fallback to find
            if (context.characters && context.characterId !== undefined) {
                 // Assuming the current chat belongs to the current character mostly
                 const current = context.characters[context.characterId];
                 if (current && current.name === message.name) return current;
            }
            const character = context.characters.find(c => c.name === message.name);
            return character;
        }

        /**
         * Gets assets for a character (file-based)
         * @param {Object} character - Character object
         * @returns {Array} - Array of asset info
         */
        static getAssetsRaw(character) {
            if (character && character.data && character.data.extensions) {
                // Prefer new file-based assets
                const fileAssets = character.data.extensions.inline_image_assets || [];
                if (fileAssets.length > 0) {
                    log(`getAssetsRaw: Found ${fileAssets.length} file-based assets`);
                    return fileAssets;
                }
                // Fallback to legacy base64 (for migration)
                const legacyAssets = character.data.extensions.inline_image_assets_b64 || [];
                if (legacyAssets.length > 0) {
                    log(`getAssetsRaw: Found ${legacyAssets.length} legacy base64 assets`);
                    return legacyAssets;
                }
            }
            log('getAssetsRaw: No assets found');
            return [];
        }

        /**
         * Saves asset metadata to character
         * @param {number} characterId - Character ID
         * @param {Array} assets - Array of asset metadata
         */
        static async saveAssets(characterId, assets) {
            // Save to new file-based field
            getContext().writeExtensionField(characterId, 'inline_image_assets', assets);
            // Invalidate cache when assets change
            invalidateAssetCache();
        }

        /**
         * Clears legacy base64 data after migration
         * @param {number} characterId - Character ID
         */
        static async clearLegacyAssets(characterId) {
            getContext().writeExtensionField(characterId, 'inline_image_assets_b64', []);
        }
    }

    // === GLOBAL PERFORMANCE BOOSTER ===
    // This runs for ALL characters, regardless of assets
    function initializePerformanceBooster() {
        if (performanceBoosterInitialized) return;
        
        log('Initializing Global Performance Booster');
        
        // Inject performance CSS
        injectPerformanceCSS();
        
        // Setup scroll performance optimizations
        setupScrollPerformance();
        
        // Apply content-visibility to existing messages
        applyContentVisibility();
        
        // Setup observer for new messages (lightweight, always active)
        setupPerformanceObserver();
        
        performanceBoosterInitialized = true;
        console.log('[InlineImageAssets] Global Performance Booster activated for all chats');
    }

    function injectPerformanceCSS() {
        if (performanceStyleElement) return;
        
        performanceStyleElement = document.createElement('style');
        performanceStyleElement.id = 'inline-assets-performance-boost';
        performanceStyleElement.textContent = `
            /* === GLOBAL PERFORMANCE OPTIMIZATIONS v5.0 === */
            /* content-visibility removed - causes scrollbar issues */
            /* Using CSS containment only for performance */
            
            /* Message container optimization */
            #chat .mes {
                contain: layout style !important;
            }
            
            /* Text content optimization */
            #chat .mes .mes_text {
                contain: layout style !important;
            }
            
            /* Avatar optimization */
            #chat .mes .avatar img {
                contain: layout !important;
            }
            
            /* Optimize swipe containers */
            #chat .mes .swipe_left,
            #chat .mes .swipe_right {
                contain: layout style !important;
            }
            
            /* Optimize message block */
            #chat .mes .mes_block {
                contain: layout style !important;
            }
            
            /* Inline asset images */
            #chat .mes .inline-asset-image {
                contain: layout !important;
                max-width: 100%;
                height: auto;
            }
        `;
        
        document.head.appendChild(performanceStyleElement);
        log('Performance CSS v5.0 injected (containment only, no content-visibility)');
    }

    function setupScrollPerformance() {
        const chatElement = document.getElementById('chat');
        if (!chatElement || chatElement.dataset.perfScrollSetup) return;
        
        // Simple scroll tracking for asset rendering optimization
        // No content-visibility manipulation needed
        chatElement.dataset.perfScrollSetup = 'true';
        log('Scroll performance v5.0 setup complete (simplified)');
    }

    function applyContentVisibility() {
        const chatElement = document.getElementById('chat');
        if (!chatElement) return;
        
        // The CSS handles most of this, but we can add data attributes for fine-tuning
        const messages = chatElement.querySelectorAll('.mes');
        const viewportHeight = window.innerHeight;
        const chatRect = chatElement.getBoundingClientRect();
        
        messages.forEach((msg) => {
            const msgRect = msg.getBoundingClientRect();
            const isVisible = msgRect.bottom >= chatRect.top && msgRect.top <= viewportHeight;
            
            // Mark visibility state for potential future optimizations
            if (!isVisible) {
                msg.dataset.offscreen = 'true';
            } else {
                delete msg.dataset.offscreen;
            }
        });
        
        log(`Applied content visibility hints to ${messages.length} messages`);
    }

    // Lightweight observer that only adds performance hints to new messages
    let performanceObserver = null;
    
    function setupPerformanceObserver() {
        const chatElement = document.getElementById('chat');
        if (!chatElement || performanceObserver) return;
        
        performanceObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.classList?.contains('mes')) {
                                // New message added - CSS will handle optimization
                                // Note: content-visibility removed to fix scrollbar issues
                            }
                        }
                    }
                }
            }
        });
        
        performanceObserver.observe(chatElement, {
            childList: true,
            subtree: false // Only watch direct children for performance
        });
        
        log('Performance observer setup complete');
    }

    // === CACHE MANAGEMENT ===
    function invalidateAssetCache() {
        assetCache.clear();
        thumbnailCache.clear();
        cachedCharacterId = null;
        cachedCharacterName = null;
        isAssetRenderingActive = false; // Reset active state
        // Also invalidate CSRF token to ensure fresh token on next request
        invalidateCsrfToken();
        log('Asset cache invalidated');
    }

    function invalidatePersonaAssetCache() {
        personaAssetCache.clear();
        cachedPersonaName = null;
        log('Persona asset cache invalidated');
    }

    /**
     * Gets current persona name from context
     * @returns {string|null} - Current persona name or null
     */
    function getCurrentPersonaName() {
        const context = getContext();
        // SillyTavern stores persona info in name1 or user_avatar
        return context.name1 || null;
    }

    /**
     * Gets persona assets from extension settings
     * @param {string} personaName - Persona name
     * @returns {Array} - Array of asset info
     */
    function getPersonaAssetsRaw(personaName) {
        if (!personaName) return [];
        
        const context = getContext();
        // Store persona assets in extension settings
        const extensionSettings = context.extensionSettings || {};
        const inlineAssetsSettings = extensionSettings.inlineImageAssets || {};
        const personaAssets = inlineAssetsSettings.personas || {};
        
        const assets = personaAssets[personaName] || [];
        log(`getPersonaAssetsRaw: Found ${assets.length} assets for persona "${personaName}"`);
        return assets;
    }

    /**
     * Saves persona assets to extension settings
     * @param {string} personaName - Persona name
     * @param {Array} assets - Array of asset metadata
     */
    async function savePersonaAssets(personaName, assets) {
        if (!personaName) return;
        
        const context = getContext();
        // Initialize settings structure if needed
        if (!context.extensionSettings.inlineImageAssets) {
            context.extensionSettings.inlineImageAssets = {};
        }
        if (!context.extensionSettings.inlineImageAssets.personas) {
            context.extensionSettings.inlineImageAssets.personas = {};
        }
        
        context.extensionSettings.inlineImageAssets.personas[personaName] = assets;
        
        // Save settings
        context.saveSettingsDebounced();
        
        // Invalidate cache
        invalidatePersonaAssetCache();
        log(`Saved ${assets.length} assets for persona "${personaName}"`);
    }

    /**
     * Builds persona asset cache
     * @param {string} personaName - Persona name
     * @returns {Promise<Map>} - Asset cache map
     */
    async function buildPersonaAssetCache(personaName) {
        if (!personaName) return new Map();
        
        // Return existing cache if valid
        if (cachedPersonaName === personaName && personaAssetCache.size > 0) {
            return personaAssetCache;
        }
        
        personaAssetCache.clear();
        const assets = getPersonaAssetsRaw(personaName);
        
        log(`Building persona asset cache for ${personaName}, ${assets.length} assets from settings`);
        
        // Also try to get file list from file system
        let fileSystemAssets = [];
        try {
            fileSystemAssets = await listPersonaImages(personaName);
            log(`Found ${fileSystemAssets.length} persona files in file system (user/files/)`);
        } catch (e) {
            log('Could not list persona file system assets:', e.message);
        }
        
        // Create a map of filename -> URL from file system
        const fileUrlMap = new Map();
        fileSystemAssets.forEach(fa => {
            if (fa.filename && fa.url) {
                fileUrlMap.set(fa.filename, fa.url);
                fileUrlMap.set(fa.name, fa.url);
                const sanitizedName = sanitizeFilename(fa.name);
                if (sanitizedName !== fa.name) {
                    fileUrlMap.set(sanitizedName, fa.url);
                }
                fileUrlMap.set(fa.name.toLowerCase(), fa.url);
            }
        });
        
        for (const asset of assets) {
            if (asset.name) {
                let url = asset.url;
                
                if (!url && asset.filename) {
                    url = `/user/files/${asset.filename}`;
                } else if (!url && fileUrlMap.has(asset.name)) {
                    url = fileUrlMap.get(asset.name);
                }
                
                if (url) {
                    personaAssetCache.set(asset.name, url);
                    log(`Cached persona asset: ${asset.name} -> ${url}`);
                    
                    const sanitizedName = sanitizeFilename(asset.name);
                    if (sanitizedName !== asset.name && !personaAssetCache.has(sanitizedName)) {
                        personaAssetCache.set(sanitizedName, url);
                    }
                    
                    const lowerName = asset.name.toLowerCase();
                    if (!personaAssetCache.has(lowerName)) {
                        personaAssetCache.set(lowerName, url);
                    }
                }
            }
        }
        
        // Also add any file system assets not in settings
        fileSystemAssets.forEach(fa => {
            if (fa.name && !personaAssetCache.has(fa.name) && fa.url) {
                personaAssetCache.set(fa.name, fa.url);
                log(`Added persona file system asset to cache: ${fa.name} -> ${fa.url}`);
                
                const sanitizedName = sanitizeFilename(fa.name);
                if (sanitizedName !== fa.name && !personaAssetCache.has(sanitizedName)) {
                    personaAssetCache.set(sanitizedName, fa.url);
                }
                
                const lowerName = fa.name.toLowerCase();
                if (!personaAssetCache.has(lowerName)) {
                    personaAssetCache.set(lowerName, fa.url);
                }
            }
        });
        
        cachedPersonaName = personaName;
        
        log(`Persona asset cache built: ${personaAssetCache.size} items for persona ${personaName}`);
        return personaAssetCache;
    }

    /**
     * Check if current character has any assets.
     * This is the KEY function for asset rendering mode.
     * @returns {boolean} true if character has assets
     */
    function checkCharacterHasAssets() {
        const context = getContext();
        if (!context.characters || context.characterId === undefined) {
            return false;
        }
        
        const character = context.characters[context.characterId];
        if (!character) return false;
        
        const assets = ContextUtil.getAssetsRaw(character);
        return assets && assets.length > 0;
    }

    /**
     * Activate or deactivate ASSET RENDERING based on whether assets exist.
     * Note: Performance booster is ALWAYS active regardless of this.
     */
    function updateAssetRenderingState() {
        const hasAssets = checkCharacterHasAssets();
        const wasActive = isAssetRenderingActive;
        isAssetRenderingActive = hasAssets;
        
        if (hasAssets && !wasActive) {
            log('Asset Rendering ACTIVATED - character has assets');
            activateAssetObservers();
        } else if (!hasAssets && wasActive) {
            log('Asset Rendering DEACTIVATED - character has no assets');
            deactivateAssetObservers();
        } else if (!hasAssets) {
            log('Asset Rendering remains DORMANT - no assets (Performance Booster still active)');
        }
        
        return hasAssets;
    }

    /**
     * Activate asset-related observers (only called when assets exist)
     */
    function activateAssetObservers() {
        const chatElement = document.getElementById('chat');
        if (!chatElement) return;
        
        // Setup scroll detection for asset rendering
        if (!scrollListenerAttached) {
            setupScrollDetection();
        }
        
        // Setup MutationObserver for asset rendering
        if (!chatObserver) {
            chatObserver = new MutationObserver((mutations) => {
                if (!isAssetRenderingActive) return; // Double-check
                
                mutationBatch.push(...mutations);
                
                if (mutationTimeout) {
                    clearTimeout(mutationTimeout);
                }
                
                mutationTimeout = setTimeout(() => {
                    processMutationBatch();
                    mutationTimeout = null;
                }, 50);
            });
        }
        
        chatObserver.observe(chatElement, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        
        // Setup visibility observer for lazy asset loading
        setupVisibilityObserver();
        
        // Process existing messages for assets
        initialLoadMessages();
    }

    /**
     * Deactivate asset-related observers (zero overhead for asset rendering)
     * Note: Performance booster remains active
     */
    function deactivateAssetObservers() {
        // Disconnect asset MutationObserver
        if (chatObserver) {
            chatObserver.disconnect();
        }
        
        // Disconnect asset IntersectionObserver
        if (visibilityObserver) {
            visibilityObserver.disconnect();
            visibilityObserver = null;
        }
        
        // Clear asset queues
        renderQueue = [];
        mutationBatch = [];
        
        log('Asset observers deactivated - Performance Booster still active');
    }

    async function buildAssetCache(character, context) {
        const charId = context.characterId;
        
        // Return existing cache if valid
        if (cachedCharacterId === charId && assetCache.size > 0) {
            return assetCache;
        }
        
        // Rebuild cache
        assetCache.clear();
        const assets = ContextUtil.getAssetsRaw(character);
        
        log(`Building asset cache for ${character.name}, ${assets.length} assets from metadata`);
        
        // Also try to get file list from file system for URL verification
        let fileSystemAssets = [];
        try {
            fileSystemAssets = await listCharacterImages(character.name);
            log(`Found ${fileSystemAssets.length} files in file system (user/files/)`);
        } catch (e) {
            log('Could not list file system assets:', e.message);
        }
        
        // === NEW: Also scan user/images/{characterName}/ directory ===
        // This is the primary location for manually managed images
        let userImagesAssets = [];
        try {
            // Get known asset names to help with scanning
            const knownNames = assets.map(a => a.name);
            userImagesAssets = await scanUserImagesDirectory(character.name, knownNames);
            log(`Found ${userImagesAssets.length} files in user/images/${character.name}/`);
        } catch (e) {
            log('Could not scan user/images/ directory:', e.message);
        }
        
        // Merge all file sources
        const allFileAssets = [...fileSystemAssets, ...userImagesAssets];
        
        // Create a map of filename -> URL from file system
        // This handles unicode character names properly
        const fileUrlMap = new Map();
        allFileAssets.forEach(fa => {
            if (fa.filename && fa.url) {
                // Map both the full filename and the extracted name
                fileUrlMap.set(fa.filename, fa.url);
                fileUrlMap.set(fa.name, fa.url);
                // Also map sanitized version for lookup
                const sanitizedName = sanitizeFilename(fa.name);
                if (sanitizedName !== fa.name) {
                    fileUrlMap.set(sanitizedName, fa.url);
                }
                // Map lowercase versions for case-insensitive lookup
                fileUrlMap.set(fa.name.toLowerCase(), fa.url);
                if (sanitizedName !== fa.name) {
                    fileUrlMap.set(sanitizedName.toLowerCase(), fa.url);
                }
            }
        });
        
        log(`File URL map has ${fileUrlMap.size} entries`);
        
        for (const asset of assets) {
            if (asset.name) {
                let url = null;
                
                // Priority 1: Check if file exists in user/images/ (preferred location)
                const userImagesUrl = `/user/images/${character.name}/${asset.name}`;
                if (userImagesAssets.some(a => a.name === asset.name)) {
                    const found = userImagesAssets.find(a => a.name === asset.name);
                    url = found?.url;
                    log(`Found in user/images/: "${asset.name}" -> ${url}`);
                }
                // Priority 2: Use existing URL if valid
                else if (asset.url) {
                    url = asset.url.startsWith('/') ? asset.url : `/${asset.url}`;
                }
                // Priority 3: Construct URL from filename
                else if (asset.filename) {
                    url = `/user/files/${asset.filename}`;
                }
                // Priority 4: Try to find in file system by name
                else if (fileUrlMap.has(asset.name)) {
                    url = fileUrlMap.get(asset.name);
                    log(`Found URL from file system for "${asset.name}": ${url}`);
                }
                // Priority 5: Try sanitized name in file system
                else {
                    const sanitizedName = sanitizeFilename(asset.name);
                    if (fileUrlMap.has(sanitizedName)) {
                        url = fileUrlMap.get(sanitizedName);
                        log(`Found URL from file system via sanitized name for "${asset.name}": ${url}`);
                    }
                }
                // Priority 6: For legacy base64 assets, store the data directly
                if (!url && asset.data) {
                    assetCache.set(asset.name, asset.data);
                    // Also cache under sanitized name for lookup
                    const sanitizedName = sanitizeFilename(asset.name);
                    if (sanitizedName !== asset.name) {
                        assetCache.set(sanitizedName, asset.data);
                    }
                    log(`Cached legacy asset: ${asset.name} (base64)`);
                    continue;
                }
                
                if (url) {
                    // Cache under original name
                    assetCache.set(asset.name, url);
                    log(`Cached asset: ${asset.name} -> ${url}`);
                    
                    // Also cache under sanitized name for lookup flexibility
                    const sanitizedName = sanitizeFilename(asset.name);
                    if (sanitizedName !== asset.name && !assetCache.has(sanitizedName)) {
                        assetCache.set(sanitizedName, url);
                        log(`Also cached as sanitized: ${sanitizedName} -> ${url}`);
                    }

                    // Also cache under canonical key (matches /api/images/upload base-name sanitization)
                    const canonicalKey = getCanonicalAssetKey(asset.name);
                    if (canonicalKey !== asset.name && !assetCache.has(canonicalKey)) {
                        assetCache.set(canonicalKey, url);
                    }
                    
                    // Also cache under lowercase for case-insensitive lookup
                    const lowerName = asset.name.toLowerCase();
                    if (!assetCache.has(lowerName)) {
                        assetCache.set(lowerName, url);
                    }
                } else {
                    log(`Warning: No URL found for asset "${asset.name}"`);
                }
            }
        }
        
        // Also add any file system assets not in metadata
        // This ensures images in user/images/ are available even without explicit registration
        allFileAssets.forEach(fa => {
            if (fa.name && !assetCache.has(fa.name) && fa.url) {
                assetCache.set(fa.name, fa.url);
                log(`Added file system asset to cache: ${fa.name} -> ${fa.url}`);
                
                // Also add sanitized version
                const sanitizedName = sanitizeFilename(fa.name);
                if (sanitizedName !== fa.name && !assetCache.has(sanitizedName)) {
                    assetCache.set(sanitizedName, fa.url);
                }

                // Also add canonical version
                const canonicalKey = getCanonicalAssetKey(fa.name);
                if (canonicalKey !== fa.name && !assetCache.has(canonicalKey)) {
                    assetCache.set(canonicalKey, fa.url);
                }
                
                // Also add lowercase version for case-insensitive lookup
                const lowerName = fa.name.toLowerCase();
                if (!assetCache.has(lowerName)) {
                    assetCache.set(lowerName, fa.url);
                }
            }
        });
        
        cachedCharacterId = charId;
        cachedCharacterName = character.name;
        
        // Update active state based on cache
        isAssetRenderingActive = assetCache.size > 0;
        
        log(`Asset cache built: ${assetCache.size} items for character ${charId}`);
        log('Cache contents:', Array.from(assetCache.keys()).join(', '));
        return assetCache;
    }

    /**
     * Parses an asset name to extract base name, separator, and number.
     * Matches trailing numbers with or without separator (e.g., name.1, name_1, happy1)
     * @param {string} name - Asset name
     * @returns {Object} - { original, base, separator, num, hasNumber }
     */
    function parseAssetNameForCompression(name) {
        // First try: Match patterns with separator (name.1, name_1, name-1)
        const matchWithSep = name.match(/^(.+)([._\-])(\d+)$/);
        if (matchWithSep) {
            return {
                original: name,
                base: matchWithSep[1],
                separator: matchWithSep[2],
                num: parseInt(matchWithSep[3], 10),
                hasNumber: true
            };
        }
        
        // Second try: Match patterns without separator (happy1, happy2)
        const matchNoSep = name.match(/^([a-zA-Z_]+)(\d+)$/);
        if (matchNoSep) {
            return {
                original: name,
                base: matchNoSep[1],
                separator: '',
                num: parseInt(matchNoSep[2], 10),
                hasNumber: true
            };
        }
        
        return { original: name, base: null, separator: null, num: null, hasNumber: false };
    }

    /**
     * Extracts the base name from an asset filename.
     * Returns the part before the first underscore (or the whole name if no underscore).
     * e.g., "Junpei_nsfw_1" -> "Junpei"
     * e.g., "Junpei_summer_2" -> "Junpei"
     * e.g., "happy1" -> "happy"
     * @param {string} name - Asset name
     * @returns {string} - Base name (first part before underscore)
     */
    function extractBaseName(name) {
        // Remove trailing number suffix first (e.g., .1, _1, or just 1)
        let cleanName = name.replace(/[._\-]\d+$/, '');
        
        // Also remove trailing numbers without separator (e.g., happy1 -> happy)
        cleanName = cleanName.replace(/\d+$/, '');
        
        // For underscore-separated names, use FIRST underscore to get base name
        if (cleanName.includes('_')) {
            const firstUnderscoreIndex = cleanName.indexOf('_');
            if (firstUnderscoreIndex > 0) {
                return cleanName.substring(0, firstUnderscoreIndex);
            }
        }
        
        // For space-separated names, use first word as base
        if (cleanName.includes(' ')) {
            const firstSpaceIndex = cleanName.indexOf(' ');
            if (firstSpaceIndex > 0) {
                return cleanName.substring(0, firstSpaceIndex);
            }
        }
        
        // If no separator, return the clean name
        return cleanName || name;
    }

    /**
     * Extracts the folder/category name from an asset name.
     * First tries to match against existing folder names (case-insensitive).
     * If no match found, extracts the base name (first part before underscore).
     * e.g., "Junpei_nsfw_1" with existing folder "Junpei" -> "Junpei"
     * e.g., "bote_bunny_admiring" with no existing "bote" folder -> "bote"
     * @param {string} name - Asset name
     * @param {Set<string>} existingFolders - Set of existing folder names (optional)
     * @returns {string} - Folder/category name
     */
    function getFolderName(name, existingFolders = null) {
        // Remove trailing number suffix first (e.g., .1, _1, or just 1)
        let cleanName = name.replace(/[._\-]\d+$/, '');
        
        // Also remove trailing numbers without separator (e.g., happy1 -> happy)
        cleanName = cleanName.replace(/\d+$/, '');
        
        // If we have existing folders, try to match against them
        if (existingFolders && existingFolders.size > 0) {
            // Try progressively shorter prefixes to find a matching folder
            // e.g., for "Junpei_nsfw_1", try "Junpei_nsfw", then "Junpei"
            
            // First, try the base name (first part before underscore)
            const baseName = extractBaseName(name);
            
            // Check if base name matches any existing folder (case-insensitive)
            for (const folder of existingFolders) {
                if (folder.toLowerCase() === baseName.toLowerCase()) {
                    return folder; // Return the existing folder name with original case
                }
            }
            
            // If underscore-separated, try each prefix level
            if (cleanName.includes('_')) {
                const parts = cleanName.split('_');
                // Try from longest to shortest prefix
                for (let i = parts.length - 1; i >= 1; i--) {
                    const prefix = parts.slice(0, i).join('_');
                    for (const folder of existingFolders) {
                        if (folder.toLowerCase() === prefix.toLowerCase()) {
                            return folder; // Return the existing folder name with original case
                        }
                    }
                }
            }
            
            // If space-separated, try each prefix level
            if (cleanName.includes(' ')) {
                const parts = cleanName.split(' ');
                for (let i = parts.length - 1; i >= 1; i--) {
                    const prefix = parts.slice(0, i).join(' ');
                    for (const folder of existingFolders) {
                        if (folder.toLowerCase() === prefix.toLowerCase()) {
                            return folder;
                        }
                    }
                }
            }
        }
        
        // No existing folder match found - extract base name
        // For underscore-separated names, use FIRST underscore to get base name
        if (cleanName.includes('_')) {
            const firstUnderscoreIndex = cleanName.indexOf('_');
            if (firstUnderscoreIndex > 0) {
                return cleanName.substring(0, firstUnderscoreIndex);
            }
        }
        
        // For space-separated names, try to find a sensible split point
        if (cleanName.includes(' ')) {
            const parts = cleanName.split(' ');
            
            // If we have 3+ parts, assume first 2 are the name (e.g., "alice croft")
            if (parts.length >= 3) {
                let splitIndex = parts.length - 1;
                for (let i = 1; i < parts.length; i++) {
                    if (parts[i].length > 0 && parts[i][0] === parts[i][0].toLowerCase()) {
                        splitIndex = i;
                        break;
                    }
                }
                
                if (splitIndex > 0) {
                    return parts.slice(0, splitIndex).join(' ');
                }
            }
            
            // Fallback: use all but last word
            if (parts.length >= 2) {
                return parts.slice(0, -1).join(' ');
            }
        }
        
        // If no separator, return the clean name (base name without numbers)
        return cleanName || name;
    }

    /**
     * Compresses asset names by grouping files with the same folder/category.
     * Groups numbered files and also groups files by their folder name.
     * Uses the same folder detection logic as groupAssetsByFolder for consistency.
     * e.g., ["Junpei_nsfw_1", "Junpei_summer_2"] -> '"Junpei_[nsfw_1, summer_2]"'
     * e.g., ["maid_flustered.1", "maid_flustered.2"] -> '"maid_flustered.1~2"'
     * @param {string[]} names - Array of asset names
     * @returns {string} - Compressed string representation
     */
    function compressAssetNames(names) {
        if (names.length === 0) return '';
        
        // First, build the set of potential folders (same logic as groupAssetsByFolder)
        const potentialFolders = new Set();
        names.forEach(name => {
            const baseName = extractBaseName(name);
            if (baseName) {
                potentialFolders.add(baseName);
            }
        });
        
        // Group by folder name using the same logic as groupAssetsByFolder
        const folderGroups = new Map();
        names.forEach(name => {
            const folderName = getFolderName(name, potentialFolders);
            if (!folderGroups.has(folderName)) {
                folderGroups.set(folderName, []);
            }
            folderGroups.get(folderName).push(name);
        });
        
        const result = [];
        
        folderGroups.forEach((groupNames, folderName) => {
            if (groupNames.length === 1) {
                // Single item, just add as-is
                result.push(`"${groupNames[0]}"`);
            } else {
                // Multiple items in the same folder
                // Check if they have numbers for range compression
                const parsed = groupNames.map(parseAssetNameForCompression);
                const numbered = parsed.filter(i => i.hasNumber);
                const nonNumbered = parsed.filter(i => !i.hasNumber);
                
                // Process numbered items (range compression)
                if (numbered.length > 0) {
                    // Group by base + separator
                    const numGroups = new Map();
                    numbered.forEach(item => {
                        const key = item.base + '|' + item.separator;
                        if (!numGroups.has(key)) {
                            numGroups.set(key, []);
                        }
                        numGroups.get(key).push(item);
                    });
                    
                    numGroups.forEach((items) => {
                        items.sort((a, b) => a.num - b.num);
                        
                        // Find consecutive ranges
                        const ranges = [];
                        let rangeStart = items[0];
                        let rangeEnd = items[0];
                        
                        for (let i = 1; i < items.length; i++) {
                            if (items[i].num === rangeEnd.num + 1) {
                                rangeEnd = items[i];
                            } else {
                                ranges.push({ start: rangeStart, end: rangeEnd });
                                rangeStart = items[i];
                                rangeEnd = items[i];
                            }
                        }
                        ranges.push({ start: rangeStart, end: rangeEnd });
                        
                        ranges.forEach(range => {
                            if (range.start.num === range.end.num) {
                                result.push(`"${range.start.original}"`);
                            } else {
                                result.push(`"${range.start.base}${range.start.separator}${range.start.num}~${range.end.num}"`);
                            }
                        });
                    });
                }
                
                // Process non-numbered items (expression list compression)
                if (nonNumbered.length > 0) {
                    // Extract expression names (part after the folder name)
                    let detectedSeparator = null;
                    const expressions = nonNumbered.map(item => {
                        const name = item.original;
                        if (name.toLowerCase().startsWith(folderName.toLowerCase())) {
                            // Remove folder name and detect separator
                            let remaining = name.substring(folderName.length);
                            // Detect separator type (underscore or space)
                            if (remaining.startsWith('_')) {
                                detectedSeparator = '_';
                                remaining = remaining.substring(1);
                            } else if (remaining.startsWith(' ')) {
                                detectedSeparator = ' ';
                                remaining = remaining.substring(1);
                            }
                            return remaining;
                        }
                        return name;
                    });
                    
                    // If we have multiple expressions, compress them with actual separator info
                    if (expressions.length > 1 && expressions.every(e => e.length > 0)) {
                        // Show the actual format hint in the compressed output
                        const sep = detectedSeparator || '_';
                        const sepName = sep === '_' ? 'underscore' : 'space';
                        result.push(`"${folderName}${sep}[${expressions.join(', ')}]" (${sepName}-separated)`);
                    } else {
                        // Fallback: add each item individually
                        nonNumbered.forEach(item => {
                            result.push(`"${item.original}"`);
                        });
                    }
                }
            }
        });
        
        return result.join(', ');
    }

    // === SCROLL DETECTION (for asset rendering) ===
    function setupScrollDetection() {
        if (scrollListenerAttached) return;
        
        const chatElement = document.getElementById('chat');
        if (!chatElement) return;
        
        chatElement.addEventListener('scroll', () => {
            // Only process asset rendering if active
            if (!isAssetRenderingActive) return;
            
            lastScrollTime = Date.now();
            isScrolling = true;
            
            if (scrollTimeout) {
                clearTimeout(scrollTimeout);
            }
            
            scrollTimeout = setTimeout(() => {
                isScrolling = false;
                // Resume asset rendering after scroll stops
                if (renderQueue.length > 0 && isAssetRenderingActive) {
                    scheduleRender();
                }
            }, SCROLL_THROTTLE);
        }, { passive: true });
        
        scrollListenerAttached = true;
    }

    // === BATCH RENDERING SYSTEM (for assets) ===
    function scheduleRender() {
        // Skip if asset rendering is not active
        if (!isAssetRenderingActive || isRenderScheduled) return;
        
        // Don't schedule during active scrolling for smoother experience
        if (isScrolling) {
            return;
        }
        
        isRenderScheduled = true;
        
        // Use requestIdleCallback for non-urgent rendering
        requestIdleCallback((deadline) => {
            processBatchRender(deadline);
            isRenderScheduled = false;
        }, { timeout: 100 }); // Max wait 100ms
    }

    function queueMessageForRender(messageElement) {
        // Skip if asset rendering is not active
        if (!isAssetRenderingActive) return;
        
        if (!renderQueue.includes(messageElement)) {
            renderQueue.push(messageElement);
            scheduleRender();
        }
    }

    async function processBatchRender(deadline) {
        // Skip if asset rendering is not active
        if (!isAssetRenderingActive) {
            isRenderScheduled = false;
            renderQueue = [];
            return;
        }
        
        // Skip if scrolling
        if (isScrolling) {
            isRenderScheduled = false;
            return;
        }
        
        const context = getContext();
        if (!context.chat || context.chat.length === 0) return;
        
        // Get character once for the batch
        const character = context.characters?.[context.characterId];
        if (!character) return;
        
        // Build/get asset cache once for the batch
        const cache = await buildAssetCache(character, context);
        
        // Build persona cache as well (for fallback)
        const personaName = getCurrentPersonaName();
        let pCache = new Map();
        if (personaName) {
            pCache = await buildPersonaAssetCache(personaName);
        }
        
        if (cache.size === 0 && pCache.size === 0) {
            // No assets - clear queue and deactivate
            renderQueue = [];
            isAssetRenderingActive = false;
            return;
        }
        
        let processed = 0;
        const maxBatch = BATCH_SIZE;
        
        // Process messages while we have time and items
        while (renderQueue.length > 0 && processed < maxBatch) {
            // Check if we should yield to browser (if deadline provided)
            if (deadline && deadline.timeRemaining() < 2) {
                break;
            }
            
            const messageElement = renderQueue.shift();
            if (messageElement) {
                renderMessageFast(messageElement, context, character, cache, pCache);
                processed++;
            }
        }
        
        // If more messages in queue, schedule next batch
        if (renderQueue.length > 0 && !isScrolling && isAssetRenderingActive) {
            isRenderScheduled = false;
            scheduleRender();
        }
    }

    // Ultra-fast render function using cached data
    // Now supports both character cache (priority) and persona cache (fallback)
    function renderMessageFast(messageElement, context, character, cache, personaCache = new Map()) {
        // Skip if being processed (prevent concurrent processing)
        if (messageElement.dataset.rendering) {
            return;
        }
        
        // Check if already processed - but verify content doesn't have unconverted tags
        if (processedMessages.has(messageElement)) {
            const textElement = messageElement.querySelector('.mes_text');
            if (textElement) {
                const html = textElement.innerHTML;
                // If still has %%img: tags, need to re-process
                if (!html.includes('%%img:')) {
                    return; // Already fully processed
                }
                // Has unconverted tags - continue processing
                log('Re-processing message with unconverted tags:', messageElement.getAttribute('mesid'));
            } else {
                return;
            }
        }
        
        // Skip if we know this message has no image tags (and hasn't changed)
        if (noImageTagMessages.has(messageElement)) {
            const textElement = messageElement.querySelector('.mes_text');
            if (textElement && !textElement.innerHTML.includes('%%img:')) {
                return;
            }
            // Content changed, remove from no-tag set conceptually and continue
        }
        
        if (!messageElement.closest('#chat')) {
            return;
        }

        const mesId = parseInt(messageElement.getAttribute('mesid'));
        if (isNaN(mesId)) return;

        const message = context.chat[mesId];
        if (!message) return;
        
        const textElement = messageElement.querySelector('.mes_text');
        if (!textElement) return;

        const html = textElement.innerHTML;
        
        // Quick check - if no %%img: tag, mark and skip
        if (!html.includes('%%img:')) {
            noImageTagMessages.add(messageElement);
            return;
        }

        log(`Fast rendering mesId ${mesId}`);
        messageElement.dataset.rendering = 'true';

        let modified = false;

        // Use cached Map for O(1) lookups instead of O(n) array.find()
        // Priority: character cache first, then persona cache as fallback
        const finalHtml = html.replace(tagRegex, (match, assetName) => {
            const trimmedName = assetName.trim();

            // Support tags that include an extension (e.g. %%img:smile.png%%)
            let baseNameFromExt = null;
            if (trimmedName.includes('.')) {
                const lastDot = trimmedName.lastIndexOf('.');
                if (lastDot > 0 && lastDot < trimmedName.length - 1) {
                    const maybeExt = trimmedName.substring(lastDot + 1).toLowerCase();
                    if (SUPPORTED_FORMATS.includes(maybeExt)) {
                        baseNameFromExt = trimmedName.substring(0, lastDot);
                    }
                }
            }

            const candidates = baseNameFromExt ? [trimmedName, baseNameFromExt] : [trimmedName];
            
            let assetSource = null;

            // Try exact match first (character cache)
            for (const candidate of candidates) {
                assetSource = cache.get(candidate);
                if (assetSource) break;
            }
            
            // If not found in character cache, try persona cache
            if (!assetSource && personaCache.size > 0) {
                for (const candidate of candidates) {
                    assetSource = personaCache.get(candidate);
                    if (assetSource) break;
                }
                if (assetSource) {
                    log(`Found asset in persona cache: "${trimmedName}"`);
                }
            }
            
            // If not found, try sanitized version (handles spaces -> underscores, etc.)
            if (!assetSource) {
                for (const candidate of candidates) {
                    const sanitizedName = sanitizeFilename(candidate);
                    assetSource = cache.get(sanitizedName);
                    if (!assetSource && personaCache.size > 0) {
                        assetSource = personaCache.get(sanitizedName);
                    }
                    if (assetSource) {
                        log(`Found asset via sanitized name: "${trimmedName}" -> "${sanitizedName}"`);
                        break;
                    }

                    // Also try canonical key (matches /api/images/upload base-name sanitization)
                    const canonicalKey = getCanonicalAssetKey(candidate);
                    assetSource = cache.get(canonicalKey);
                    if (!assetSource && personaCache.size > 0) {
                        assetSource = personaCache.get(canonicalKey);
                    }
                    if (assetSource) {
                        log(`Found asset via canonical key: "${trimmedName}" -> "${canonicalKey}"`);
                        break;
                    }
                }
            }
            
            // If still not found, try case-insensitive search (both caches)
            if (!assetSource) {
                const lowerName = trimmedName.toLowerCase();
                // Try character cache first
                for (const [key, value] of cache.entries()) {
                    if (key.toLowerCase() === lowerName) {
                        assetSource = value;
                        log(`Found asset via case-insensitive match: "${trimmedName}" -> "${key}"`);
                        break;
                    }
                }
                // If not found, try persona cache
                if (!assetSource && personaCache.size > 0) {
                    for (const [key, value] of personaCache.entries()) {
                        if (key.toLowerCase() === lowerName) {
                            assetSource = value;
                            log(`Found asset in persona cache via case-insensitive match: "${trimmedName}" -> "${key}"`);
                            break;
                        }
                    }
                }
            }
            
            // If still not found, try direct URL to user/images/ as last resort
            if (!assetSource && character?.name) {
                // Try common extensions
                const possibleUrls = SUPPORTED_FORMATS.map(ext =>
                    `/user/images/${character.name}/${trimmedName}.${ext}`
                );
                
                // We can't do async fetch here, so just try the first likely extension
                // The image will fail to load if wrong, but at least we tried
                assetSource = `/user/images/${character.name}/${trimmedName}.png`;
                log(`Trying direct URL as fallback: "${trimmedName}" -> ${assetSource}`);
            }
            
            if (assetSource) {
                modified = true;
                // assetSource can be either a URL path or base64 data
                // Use escaped quotes for onerror to avoid HTML parsing issues
                const escapedName = trimmedName.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                return `<img src="${assetSource}" alt="${escapedName}" class="inline-asset-image" loading="lazy" onerror="this.style.display='none'">`;
            }
            
            log(`Asset not found in cache: "${trimmedName}"`);
            return match;
        });

        if (modified) {
            textElement.innerHTML = finalHtml;
        }
        
        // Mark as processed
        processedMessages.add(messageElement);
        delete messageElement.dataset.rendering;
    }

    // Legacy function for compatibility (now uses batch system)
    function renderMessage(messageElement) {
        queueMessageForRender(messageElement);
    }

    // === VISIBILITY-BASED LAZY LOADING (for assets) ===
    function setupVisibilityObserver() {
        // Don't create observer if asset rendering is not active
        if (!isAssetRenderingActive) return null;
        
        if (visibilityObserver) {
            visibilityObserver.disconnect();
        }
        
        visibilityObserver = new IntersectionObserver((entries) => {
            // Skip if asset rendering is not active
            if (!isAssetRenderingActive) return;
            
            // Don't process during fast scrolling
            if (isScrolling && Date.now() - lastScrollTime < 50) {
                return;
            }
            
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const messageElement = entry.target;
                    if (!processedMessages.has(messageElement) && !noImageTagMessages.has(messageElement)) {
                        queueMessageForRender(messageElement);
                    }
                    // Stop observing once queued
                    visibilityObserver.unobserve(messageElement);
                }
            }
        }, {
            root: document.getElementById('chat'),
            rootMargin: '300px 0px', // Pre-load messages 300px before they become visible
            threshold: 0
        });
        
        return visibilityObserver;
    }

    function observeMessage(messageElement) {
        // Skip if asset rendering is not active
        if (!isAssetRenderingActive || !visibilityObserver) return;
        
        if (!processedMessages.has(messageElement)) {
            visibilityObserver.observe(messageElement);
        }
    }

    // === INITIAL LOAD OPTIMIZATION (for assets) ===
    function initialLoadMessages() {
        // Skip asset processing if not active
        if (!isAssetRenderingActive) {
            log('Asset initial load SKIPPED - no assets (Performance Booster still active)');
            return;
        }
        
        const chatElement = document.getElementById('chat');
        if (!chatElement) return;
        
        const messages = chatElement.querySelectorAll('.mes');
        if (messages.length === 0) return;
        
        log(`Initial load: ${messages.length} messages`);
        
        // Setup visibility observer
        setupVisibilityObserver();
        
        // For messages already in viewport, render immediately
        // For others, use IntersectionObserver for lazy loading
        const viewportHeight = window.innerHeight;
        const chatRect = chatElement.getBoundingClientRect();
        
        const immediateRender = [];
        const lazyRender = [];
        
        messages.forEach((msg) => {
            const msgRect = msg.getBoundingClientRect();
            // Check if message is in or near viewport
            if (msgRect.bottom >= chatRect.top - 200 && msgRect.top <= viewportHeight + 200) {
                immediateRender.push(msg);
            } else {
                lazyRender.push(msg);
            }
        });
        
        log(`Immediate render: ${immediateRender.length}, Lazy render: ${lazyRender.length}`);
        
        // Queue immediate renders
        for (const msg of immediateRender) {
            queueMessageForRender(msg);
        }
        
        // Setup lazy loading for off-screen messages
        for (const msg of lazyRender) {
            observeMessage(msg);
        }
    }

    // --- Popup and Asset Management ---
    
    // Globals for Popup Pagination
    let currentPopupAssets = [];
    let currentPopupRenderCount = 0;
    const ASSETS_PER_PAGE = 50; // Render 50 at a time to prevent freeze
    
    // Selection state for multi-select delete
    let selectedAssets = new Set();
    let isSelectionMode = false;

    async function createAssetManagerPopup() {
        const context = getContext();
        if (!context.characters[context.characterId]) {
            toastr.error("Please select a character first.");
            return null;
        }
        const character = context.characters[context.characterId];

        const container = document.createElement('div');
        container.className = 'inline-assets-popup-container';

        container.innerHTML = `
            <div class="inline-assets-header">
                <h3>Image Assets for ${character.name}</h3>
                <div class="inline-assets-header-actions">
                    <div id="refresh-assets-btn" class="menu_button menu_button_icon" title="Refresh Assets">
                        <i class="fa-solid fa-sync"></i>
                    </div>
                    <div id="import-charx-btn" class="menu_button menu_button_icon" title="Import Charx Assets">
                        <i class="fa-solid fa-file-import"></i>
                    </div>
                    <div id="generate-prompt-btn" class="menu_button menu_button_icon" title="Copy Asset List Prompt">
                        <i class="fa-solid fa-file-invoice"></i>
                    </div>
                    <div id="download-zip-btn" class="menu_button menu_button_icon" title="Download All as ZIP">
                        <i class="fa-solid fa-file-zipper"></i>
                    </div>
                    <label class="menu_button menu_button_icon">
                        <i class="fa-solid fa-upload"></i>
                        <span>Upload</span>
                        <input type="file" id="asset-upload-input" multiple accept="image/*,image/webp" style="display: none;">
                    </label>
                </div>
            </div>
            <div class="inline-assets-toolbar">
                <div class="inline-assets-toolbar-left">
                    <i class="fa-solid fa-tags"></i>
                    <div id="inline-assets-tag-filter-container"></div>
                </div>
                <div class="inline-assets-toolbar-right">
                    <div id="toggle-selection-btn" class="menu_button menu_button_icon" title="Toggle Selection Mode">
                        <i class="fa-solid fa-check-square"></i>
                    </div>
                    <div id="select-all-btn" class="menu_button menu_button_icon" title="Select All" style="display: none;">
                        <i class="fa-solid fa-check-double"></i>
                    </div>
                    <div id="delete-selected-btn" class="menu_button menu_button_icon danger" title="Delete Selected" style="display: none;">
                        <i class="fa-solid fa-trash"></i>
                        <span id="selected-count">(0)</span>
                    </div>
                </div>
            </div>
            <div class="inline-assets-status">
                <span id="assets-count">Loading...</span>
                <span id="migration-status"></span>
            </div>
            <div id="inline-assets-gallery" class="inline-assets-gallery">
                <div class="inline-assets-loading">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    <span>Loading assets...</span>
                </div>
            </div>
            <div id="inline-assets-load-more" style="text-align:center; padding: 10px; display:none;">
                <button class="menu_button">Load More Images</button>
            </div>
        `;

        const fileInput = container.querySelector('#asset-upload-input');
        const gallery = container.querySelector('#inline-assets-gallery');
        const loadMoreBtn = container.querySelector('#inline-assets-load-more button');

        // Load More Event
        loadMoreBtn.addEventListener('click', () => {
            renderNextBatch(container, character);
        });

        gallery.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            gallery.classList.add('drag-over');
        });
        gallery.addEventListener('dragleave', (e) => {
            e.preventDefault();
            gallery.classList.remove('drag-over');
        });
        gallery.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            gallery.classList.remove('drag-over');
            
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                log(`드래그 앤 드롭: ${files.length}개 파일 감지됨`);
                await handleFileUpload(files, character, container);
            }
        });
        fileInput.addEventListener('change', async (e) => {
            if (e.target.files.length) {
                await handleFileUpload(e.target.files, character, container);
                e.target.value = '';
            }
        });

        // Refresh button
        container.querySelector('#refresh-assets-btn').addEventListener('click', async () => {
            await initializeAssetList(container, character);
            toastr.success('Assets refreshed');
        });

        // Import Charx Assets button
        container.querySelector('#import-charx-btn').addEventListener('click', async () => {
            // Show import options dialog
            const importChoice = await showImportOptionsDialog();
            
            if (importChoice === 'charx') {
                const charxAssets = await loadCharxAssets(character.name);
                if (charxAssets.length === 0) {
                    toastr.info('No charx assets found to import');
                    return;
                }
                
                if (confirm(`Found ${charxAssets.length} charx assets. Import them?`)) {
                    toastr.info('Importing charx assets...');
                    const imported = await importCharxAssets(character.name, charxAssets);
                    
                    if (imported.length > 0) {
                        const currentAssets = ContextUtil.getAssetsRaw(character);
                        const newAssets = [...currentAssets.filter(a => !a.isLegacy), ...imported];
                        await ContextUtil.saveAssets(context.characterId, newAssets);
                        
                        toastr.success(`Imported ${imported.length} charx assets`);
                        await initializeAssetList(container, character);
                    }
                }
            } else if (importChoice === 'userImages') {
                // Scan user/images/{characterName}/ directory
                const scannedAssets = await scanUserImagesDirectory(character.name);
                if (scannedAssets.length === 0) {
                    toastr.info('No images found in user/images/ directory');
                    return;
                }
                
                if (confirm(`Found ${scannedAssets.length} images. Register them as assets?`)) {
                    const currentAssets = ContextUtil.getAssetsRaw(character);
                    const existingNames = new Set(currentAssets.map(a => a.name));
                    const newAssets = scannedAssets.filter(a => !existingNames.has(a.name));
                    
                    if (newAssets.length > 0) {
                        const updatedAssets = [...currentAssets.filter(a => !a.isLegacy), ...newAssets];
                        await ContextUtil.saveAssets(context.characterId, updatedAssets);
                        toastr.success(`Registered ${newAssets.length} new assets`);
                        await initializeAssetList(container, character);
                    } else {
                        toastr.info('All found images are already registered');
                    }
                }
            } else if (importChoice === 'manual') {
                // Show manual registration dialog
                await showManualAssetDialog(character, context, container);
            }
        });

        // Download ZIP button
        container.querySelector('#download-zip-btn').addEventListener('click', async () => {
            await downloadAssetsAsZip(character, container);
        });

        // Generate prompt button
        container.querySelector('#generate-prompt-btn').addEventListener('click', async () => {
            const assets = ContextUtil.getAssetsRaw(character);
            if (assets.length === 0) {
                toastr.info("No assets available.");
                return;
            }
            const compressedNames = compressAssetNames(assets.map(asset => asset.name));
            const promptText = `### {{char}}'s Image Asset Usage Guide

**Overview:**
You have access to pre-defined images for this character. Use them to visually enhance your descriptions and actions when appropriate.

**How to Display an Image:**
Use the tag \`%%img:filename%%\` in your response. Do not include the file extension.

**Available Image Filenames:**
${compressedNames}

**Format Guide:**
- \`name_[a, b, c]\` (underscore-separated) → Files exist as \`name_a\`, \`name_b\`, \`name_c\` → Use \`%%img:name_a%%\`
- \`name [a, b, c]\` (space-separated) → Files exist as \`name a\`, \`name b\`, \`name c\` → Use \`%%img:name a%%\`
- \`name.1~3\` → Files exist as \`name.1\`, \`name.2\`, \`name.3\` → Use \`%%img:name.1%%\`

**Note:**
If there are variations in numbers, do not use them consecutively.`;
            
            try {
                await navigator.clipboard.writeText(promptText);
                toastr.success("Prompt copied!");
            } catch (err) {
                toastr.error("Failed to copy.");
            }
        });

        // Selection mode toggle
        container.querySelector('#toggle-selection-btn').addEventListener('click', () => {
            isSelectionMode = !isSelectionMode;
            selectedAssets.clear();
            updateSelectionUI(container);
        });

        // Select all button
        container.querySelector('#select-all-btn').addEventListener('click', () => {
            const assets = ContextUtil.getAssetsRaw(character);
            if (selectedAssets.size === assets.length) {
                selectedAssets.clear();
            } else {
                assets.forEach((_, index) => selectedAssets.add(index));
            }
            updateSelectionUI(container);
        });

        // Delete selected button
        container.querySelector('#delete-selected-btn').addEventListener('click', async () => {
            if (selectedAssets.size === 0) return;
            
            if (confirm(`Are you sure you want to delete ${selectedAssets.size} selected asset(s)?`)) {
                const assets = ContextUtil.getAssetsRaw(character);
                const toDelete = Array.from(selectedAssets).sort((a, b) => b - a);
                
                // Delete files (only for non-legacy assets with filenames)
                const filenames = toDelete
                    .map(idx => assets[idx])
                    .filter(asset => asset && asset.filename && !asset.isLegacy && !asset.data)
                    .map(asset => asset.filename);
                
                if (filenames.length > 0) {
                    const results = await deleteMultipleImages(character.name, filenames);
                    if (results.failed > 0) {
                        toastr.warning(`${results.failed} file(s) failed to delete`);
                    }
                }
                
                // Count legacy assets being deleted
                const legacyCount = toDelete.filter(idx => {
                    const asset = assets[idx];
                    return asset && (asset.isLegacy || asset.data);
                }).length;
                
                if (legacyCount > 0) {
                    log(`Removing ${legacyCount} legacy assets from metadata`);
                }
                
                // Update metadata - remove all selected assets
                const newAssets = assets.filter((_, idx) => !selectedAssets.has(idx));
                await ContextUtil.saveAssets(context.characterId, newAssets);
                
                // Also clear legacy assets field if we deleted legacy assets
                if (legacyCount > 0) {
                    const remainingLegacy = newAssets.filter(a => a.isLegacy || a.data);
                    if (remainingLegacy.length === 0) {
                        await ContextUtil.clearLegacyAssets(context.characterId);
                    }
                }
                
                selectedAssets.clear();
                isSelectionMode = false;
                
                toastr.success(`Deleted ${toDelete.length} asset(s)`);
                await initializeAssetList(container, character);
            }
        });
        
        setupPopupEventListeners(container, character);
        
        // Initial Load
        await initializeAssetList(container, character);
        
        return container;
    }

    function updateSelectionUI(container) {
        const selectAllBtn = container.querySelector('#select-all-btn');
        const deleteSelectedBtn = container.querySelector('#delete-selected-btn');
        const selectedCountSpan = container.querySelector('#selected-count');
        const toggleBtn = container.querySelector('#toggle-selection-btn');
        const gallery = container.querySelector('#inline-assets-gallery');
        
        if (isSelectionMode) {
            selectAllBtn.style.display = '';
            deleteSelectedBtn.style.display = '';
            toggleBtn.classList.add('active');
            gallery.classList.add('selection-mode');
        } else {
            selectAllBtn.style.display = 'none';
            deleteSelectedBtn.style.display = 'none';
            toggleBtn.classList.remove('active');
            gallery.classList.remove('selection-mode');
        }
        
        selectedCountSpan.textContent = `(${selectedAssets.size})`;
        
        // Update checkbox states
        gallery.querySelectorAll('.asset-checkbox').forEach(checkbox => {
            const index = parseInt(checkbox.dataset.index);
            checkbox.checked = selectedAssets.has(index);
        });
    }

    function setupPopupEventListeners(popupContainer, character) {
        // Use event delegation with addEventListener for better performance
        const tagFilterContainer = popupContainer.querySelector('#inline-assets-tag-filter-container');
        const gallery = popupContainer.querySelector('#inline-assets-gallery');
        
        // Tag filter click handler - immediate response
        tagFilterContainer.addEventListener('click', async (event) => {
            const tagFilter = event.target.closest('.tag-filter');
            if (tagFilter) {
                tagFilter.classList.toggle('active');
                // Re-initialize list on filter change
                await initializeAssetList(popupContainer, character);
            }
        }, { passive: true });

        // Gallery click handler - use event delegation for all click actions
        gallery.addEventListener('click', async (event) => {
            const target = event.target;
            
            // Handle checkbox clicks in selection mode
            const checkbox = target.closest('.asset-checkbox');
            if (checkbox && isSelectionMode) {
                const index = parseInt(checkbox.dataset.index);
                if (checkbox.checked) {
                    selectedAssets.add(index);
                } else {
                    selectedAssets.delete(index);
                }
                updateSelectionUI(popupContainer);
                return;
            }
            
            // Handle item click in selection mode
            if (isSelectionMode) {
                const item = target.closest('.inline-assets-item');
                if (item && !target.closest('input') && !target.closest('.inline-assets-item-actions')) {
                    const checkbox = item.querySelector('.asset-checkbox');
                    if (checkbox) {
                        checkbox.checked = !checkbox.checked;
                        const index = parseInt(checkbox.dataset.index);
                        if (checkbox.checked) {
                            selectedAssets.add(index);
                        } else {
                            selectedAssets.delete(index);
                        }
                        updateSelectionUI(popupContainer);
                    }
                    return;
                }
            }
            
            // Find the action element
            const deleteButton = target.closest('[data-action="delete"]');
            const deleteTagButton = target.closest('[data-action="delete-tag"]');
            const previewImage = target.closest('[data-action="preview"]');
            
            // Early return if no action found
            if (!deleteButton && !deleteTagButton && !previewImage) return;
            
            // Prevent event bubbling immediately
            event.stopPropagation();
            event.preventDefault();
            
            const context = getContext();
            // Optimization: operate on RAW array reference to avoid full copy
            const assets = ContextUtil.getAssetsRaw(character);

            if (previewImage) {
                const index = parseInt(previewImage.dataset.index, 10);
                if (assets[index]) {
                    // Use requestAnimationFrame for smoother UI
                    requestAnimationFrame(() => {
                        const asset = assets[index];
                        // Use URL for file-based assets, data for legacy
                        const imageSource = asset.url || asset.data;
                        showImagePreview(imageSource, asset.name);
                    });
                }
            } else if (deleteButton) {
                const index = parseInt(deleteButton.dataset.index, 10);
                const asset = assets[index];
                if (confirm(`Are you sure you want to delete the asset "${asset.name}"?`)) {
                    const isLegacy = asset.isLegacy || asset.data;
                    
                    // Delete file if it exists (only for non-legacy assets)
                    if (asset.filename && !isLegacy) {
                        const deleteSuccess = await deleteImageFile(character.name, asset.filename);
                        if (!deleteSuccess) {
                            log(`File deletion failed for ${asset.filename}, but will remove from metadata`);
                        }
                    } else if (isLegacy) {
                        log(`Removing legacy asset "${asset.name}" from metadata (no file to delete)`);
                    }
                    
                    // Remove from assets array
                    assets.splice(index, 1);
                    await ContextUtil.saveAssets(context.characterId, assets);
                    
                    // Clear legacy assets field if no more legacy assets remain
                    if (isLegacy) {
                        const remainingLegacy = assets.filter(a => a.isLegacy || a.data);
                        if (remainingLegacy.length === 0) {
                            await ContextUtil.clearLegacyAssets(context.characterId);
                        }
                    }
                    
                    await initializeAssetList(popupContainer, character);
                }
            } else if (deleteTagButton) {
                const tagElement = target.closest('.inline-asset-tag');
                const index = parseInt(tagElement.dataset.index, 10);
                const tagToRemove = tagElement.dataset.tag;
                if(assets[index]?.tags) {
                    assets[index].tags = assets[index].tags.filter(t => t !== tagToRemove);
                    await ContextUtil.saveAssets(context.characterId, assets);
                    // Only re-render if strictly needed or just update DOM (re-render for safety)
                    await initializeAssetList(popupContainer, character);
                }
            }
        });

        // Name change handler
        gallery.addEventListener('change', async (event) => {
            if (!event.target.classList.contains('inline-assets-item-name')) return;
            
            const context = getContext();
            const assets = ContextUtil.getAssetsRaw(character);
            const index = parseInt(event.target.dataset.index, 10);
            const originalName = assets[index].name;
            const newName = event.target.value.trim();

            if (!newName) {
                toastr.error("Asset name cannot be empty.");
                event.target.value = originalName;
                return;
            }
            // Check duplicates
            if (assets.some((a, i) => i !== index && a.name === newName)) {
                toastr.error(`An asset with the name "${newName}" already exists.`);
                event.target.value = originalName;
                return;
            }
            assets[index].name = newName;
            await ContextUtil.saveAssets(context.characterId, assets);
        });

        // Tag input handler
        gallery.addEventListener('keydown', async (event) => {
            if (!event.target.classList.contains('inline-asset-tag-input') || event.key !== 'Enter') return;
            
            event.preventDefault();
            const context = getContext();
            const newTag = event.target.value.trim().toLowerCase();
            if (newTag) {
                const assets = ContextUtil.getAssetsRaw(character);
                const index = parseInt(event.target.dataset.index, 10);
                if (!assets[index].tags) assets[index].tags = [];
                if (!assets[index].tags.includes(newTag)) {
                    assets[index].tags.push(newTag);
                    await ContextUtil.saveAssets(context.characterId, assets);
                    await initializeAssetList(popupContainer, character);
                } else {
                    event.target.value = '';
                }
            }
        });
    }

    async function handleFileUpload(files, character, popupContainer) {
        files = Array.from(files);
        if (!files.length) return;
        
        const gallery = popupContainer.querySelector('#inline-assets-gallery');
        const statusSpan = popupContainer.querySelector('#assets-count');
        
        // 파일 유효성 검사 먼저 수행
        const validFiles = [];
        const invalidFiles = [];
        
        for (const file of files) {
            const validation = validateImageFile(file);
            if (validation.valid) {
                validFiles.push(file);
            } else {
                invalidFiles.push({ file, reason: validation.reason });
            }
        }
        
        // 유효하지 않은 파일이 있으면 경고 표시
        if (invalidFiles.length > 0) {
            invalidFiles.forEach(({ file, reason }) => {
                toastr.warning(`${file.name}: ${reason}`);
            });
        }
        
        // Exit if no valid files
        if (validFiles.length === 0) {
            if (invalidFiles.length > 0) {
                toastr.error('No valid files to upload.');
            }
            return;
        }
        
        // Show loading state with progress
        const totalFiles = validFiles.length;
        let completedFiles = 0;
        const updateProgress = () => {
            const percent = Math.round((completedFiles / totalFiles) * 100);
            statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading ${completedFiles}/${totalFiles} (${percent}%)...`;
        };
        updateProgress();
        
        const context = getContext();
        const assets = ContextUtil.getAssetsRaw(character);
        const existingNames = new Set(assets.map(asset => asset.name));
        
        // Pre-fetch CSRF token once before parallel uploads
        if (!csrfDisabled) {
            await fetchCsrfToken();
        }
        
        // Filter out duplicates first
        const filesToUpload = [];
        let skippedUploads = 0;
        
        for (const file of validFiles) {
            const nameWithoutExtension = file.name.substring(0, file.name.lastIndexOf('.'));
            if (existingNames.has(nameWithoutExtension)) {
                skippedUploads++;
                completedFiles++;
            } else {
                filesToUpload.push(file);
                existingNames.add(nameWithoutExtension); // Reserve the name
            }
        }
        
        updateProgress();
        
        if (filesToUpload.length === 0) {
            if (skippedUploads > 0) {
                toastr.warning(`Skipped ${skippedUploads} file(s) that already exist.`);
            }
            await initializeAssetList(popupContainer, character);
            return;
        }
        
        // Parallel upload with concurrency limit
        const CONCURRENT_UPLOADS = 4; // Upload 4 files at a time
        const results = [];
        
        for (let i = 0; i < filesToUpload.length; i += CONCURRENT_UPLOADS) {
            const batch = filesToUpload.slice(i, i + CONCURRENT_UPLOADS);
            
            const batchPromises = batch.map(async (file) => {
                try {
                    const savedFile = await saveImageFile(character.name, file.name, file);
                    completedFiles++;
                    updateProgress();
                    return { success: true, file: savedFile };
                } catch (error) {
                    console.error(`[InlineImageAssets] Failed to upload ${file.name}:`, error);
                    completedFiles++;
                    updateProgress();
                    return { success: false, error, fileName: file.name };
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
        }
        
        // Process results
        const newAssets = [];
        let successfulUploads = 0;
        let failedUploads = 0;
        
        for (const result of results) {
            if (result.success) {
                newAssets.push({
                    name: result.file.name,
                    filename: result.file.filename,
                    path: result.file.path,
                    url: result.file.url,
                    tags: []
                });
                successfulUploads++;
            } else {
                failedUploads++;
            }
        }

        // Display appropriate messages based on results
        if (successfulUploads > 0) {
            // Update metadata
            const updatedAssets = [...assets.filter(a => !a.isLegacy), ...newAssets];
            await ContextUtil.saveAssets(context.characterId, updatedAssets);
            toastr.success(`Successfully uploaded ${successfulUploads} file(s).`);
        }
        
        if (failedUploads > 0) {
            toastr.error(`Failed to upload ${failedUploads} file(s).`);
        }
        
        if (skippedUploads > 0) {
            toastr.info(`Skipped ${skippedUploads} file(s) that already exist.`);
        }
        
        // Refresh list unless all files failed
        await initializeAssetList(popupContainer, character);
    }

    /**
     * Downloads all assets as a ZIP file
     * @param {Object} character - Character object
     * @param {HTMLElement} popupContainer - Popup container for status updates
     */
    async function downloadAssetsAsZip(character, popupContainer) {
        const statusSpan = popupContainer.querySelector('#assets-count');
        const originalStatus = statusSpan.textContent;
        
        try {
            // Get all assets
            const assets = ContextUtil.getAssetsRaw(character);
            
            if (assets.length === 0) {
                toastr.info('No assets to download');
                return;
            }
            
            statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Preparing ZIP (0/${assets.length})...`;
            
            // Dynamically load JSZip if not available
            if (typeof JSZip === 'undefined') {
                statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Loading ZIP library...`;
                await loadJSZip();
            }
            
            const zip = new JSZip();
            let downloadedCount = 0;
            let failedCount = 0;
            
            // Download each asset and add to ZIP
            for (const asset of assets) {
                try {
                    const imageUrl = asset.url || asset.data;
                    if (!imageUrl) {
                        failedCount++;
                        continue;
                    }
                    
                    let blob;
                    if (imageUrl.startsWith('data:')) {
                        // Base64 data
                        blob = base64ToBlob(imageUrl);
                    } else {
                        // URL - fetch the image
                        const response = await fetch(imageUrl);
                        if (!response.ok) {
                            log(`Failed to fetch ${asset.name}: ${response.status}`);
                            failedCount++;
                            continue;
                        }
                        blob = await response.blob();
                    }
                    
                    // Determine filename with extension
                    let filename = asset.filename || asset.name;
                    if (!filename.includes('.')) {
                        // Add extension based on blob type
                        const ext = getExtensionFromMime(blob.type);
                        filename = `${filename}.${ext}`;
                    }
                    
                    zip.file(filename, blob);
                    downloadedCount++;
                    
                    statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Preparing ZIP (${downloadedCount}/${assets.length})...`;
                } catch (error) {
                    console.error(`[InlineImageAssets] Failed to add ${asset.name} to ZIP:`, error);
                    failedCount++;
                }
            }
            
            if (downloadedCount === 0) {
                toastr.error('No assets could be downloaded');
                statusSpan.textContent = originalStatus;
                return;
            }
            
            statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating ZIP file...`;
            
            // Generate ZIP file
            const zipBlob = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 }
            }, (metadata) => {
                const percent = Math.round(metadata.percent);
                statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Compressing... ${percent}%`;
            });
            
            // Create download link
            const sanitizedCharName = sanitizeFilename(character.name);
            const downloadName = `${sanitizedCharName}_assets.zip`;
            
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            statusSpan.textContent = originalStatus;
            
            if (failedCount > 0) {
                toastr.warning(`Downloaded ${downloadedCount} assets, ${failedCount} failed`);
            } else {
                toastr.success(`Downloaded ${downloadedCount} assets as ZIP`);
            }
        } catch (error) {
            console.error('[InlineImageAssets] ZIP download failed:', error);
            toastr.error('Failed to create ZIP file');
            statusSpan.textContent = originalStatus;
        }
    }

    /**
     * Dynamically loads JSZip library
     */
    async function loadJSZip() {
        return new Promise((resolve, reject) => {
            // Check if already loaded
            if (typeof JSZip !== 'undefined') {
                resolve();
                return;
            }
            
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            script.integrity = 'sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==';
            script.crossOrigin = 'anonymous';
            script.referrerPolicy = 'no-referrer';
            
            script.onload = () => {
                log('JSZip loaded successfully');
                resolve();
            };
            script.onerror = () => {
                reject(new Error('Failed to load JSZip library'));
            };
            
            document.head.appendChild(script);
        });
    }

    /**
     * Groups assets by their folder/category name.
     * First scans all assets to build a list of existing folder names,
     * then matches each asset to the appropriate folder.
     * e.g., "Junpei_nsfw_1" and "Junpei_summer_2" -> grouped under "Junpei"
     * @param {Array} assets - Array of asset objects
     * @returns {Map} - Map of folderName -> array of assets
     */
    function groupAssetsByFolder(assets) {
        const groups = new Map();
        
        // Phase 1: First pass - collect all potential folder names
        // This builds a set of existing folders to match against
        const potentialFolders = new Set();
        
        assets.forEach(asset => {
            // Extract base name (first part before underscore) as potential folder
            const baseName = extractBaseName(asset.name);
            if (baseName) {
                potentialFolders.add(baseName);
            }
        });
        
        log(`Potential folders detected: ${Array.from(potentialFolders).join(', ')}`);
        
        // Phase 2: Second pass - assign each asset to a folder
        // Now that we know all potential folders, we can match properly
        assets.forEach(asset => {
            try {
                const folderName = getFolderName(asset.name, potentialFolders);
                
                if (!groups.has(folderName)) {
                    groups.set(folderName, []);
                }
                groups.get(folderName).push(asset);
            } catch (error) {
                console.error(`[InlineImageAssets] Error grouping asset "${asset.name}":`, error);
                // Fallback: use the asset name itself as folder
                if (!groups.has(asset.name)) {
                    groups.set(asset.name, []);
                }
                groups.get(asset.name).push(asset);
            }
        });
        
        // Sort each group alphabetically by name
        groups.forEach((items) => {
            items.sort((a, b) => a.name.localeCompare(b.name));
        });
        
        // Log grouping summary
        log(`Grouping complete: ${groups.size} folders created`);
        groups.forEach((items, folderName) => {
            log(`  - "${folderName}": ${items.length} items (${items.map(i => i.name).join(', ')})`);
        });
        
        return groups;
    }

    /**
     * Shows a full-size image preview popup
     * @param {string} imageSource - Image URL or Base64 data
     * @param {string} imageName - Image name for alt text
     */
    function showImagePreview(imageSource, imageName) {
        // Remove existing preview if any
        const existingPreview = document.querySelector('.inline-asset-fullscreen-overlay');
        if (existingPreview) existingPreview.remove();
        
        const overlay = document.createElement('div');
        overlay.className = 'inline-asset-fullscreen-overlay';
        overlay.innerHTML = `
            <div class="inline-asset-fullscreen-content">
                <img src="${imageSource}" alt="${imageName}">
                <div class="inline-asset-fullscreen-name">${imageName}</div>
                <button class="inline-asset-fullscreen-close"><i class="fa-solid fa-times"></i></button>
            </div>
        `;
        
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('.inline-asset-fullscreen-close')) {
                overlay.remove();
            }
        });
        
        document.body.appendChild(overlay);
    }

    // Prepares the filtered list and resets pagination
    async function initializeAssetList(popupContainer, character) {
        const gallery = popupContainer.querySelector('#inline-assets-gallery');
        const loadMoreDiv = popupContainer.querySelector('#inline-assets-load-more');
        const statusSpan = popupContainer.querySelector('#assets-count');
        const migrationStatus = popupContainer.querySelector('#migration-status');
        
        // Show loading
        gallery.innerHTML = `
            <div class="inline-assets-loading">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <span>Loading assets...</span>
            </div>
        `;
        
        // Get assets from metadata
        let assets = ContextUtil.getAssetsRaw(character);

        // Migration status: legacy base64 + legacy user/files -> user/images
        const migrationMessages = [];

        // Legacy base64 assets
        const legacyAssets = assets.filter(a => a.isLegacy || a.data);
        if (legacyAssets.length > 0) {
            migrationMessages.push(`<span class="migration-warning"><i class="fa-solid fa-exclamation-triangle"></i> ${legacyAssets.length} legacy assets found. <a href="#" id="migrate-assets-link">Migrate now</a></span>`);
        }
        
        // Also try to load from file system (user/files/)
        const fileAssets = await listCharacterImages(character.name);

        // Legacy flat files (user/files/) that can be migrated into user/images/{character}
        const legacyFileAssets = fileAssets.filter(a => !a.isImageDir && typeof a.filename === 'string' && a.filename.startsWith(getCharacterFilePrefix(character.name)));
        if (legacyFileAssets.length > 0) {
            migrationMessages.push(`<span class="migration-warning"><i class="fa-solid fa-exclamation-triangle"></i> ${legacyFileAssets.length} user/files images found. <a href="#" id="migrate-files-link">Move to per-character folder</a></span>`);
        }

        migrationStatus.innerHTML = migrationMessages.join(' ');

        // Wire legacy base64 migration link
        popupContainer.querySelector('#migrate-assets-link')?.addEventListener('click', async (e) => {
            e.preventDefault();
            const migrated = await migrateLegacyAssets(character.name, legacyAssets);

            if (migrated.length > 0) {
                // Update metadata with migrated assets
                const nonLegacyAssets = assets.filter(a => !a.isLegacy && !a.data);
                const newAssets = [...nonLegacyAssets, ...migrated];
                await ContextUtil.saveAssets(getContext().characterId, newAssets);

                // Clear legacy data
                await ContextUtil.clearLegacyAssets(getContext().characterId);

                // Force cache rebuild
                invalidateAssetCache();

                await initializeAssetList(popupContainer, character);
            }
        });

        // Wire user/files -> user/images migration link
        popupContainer.querySelector('#migrate-files-link')?.addEventListener('click', async (e) => {
            e.preventDefault();

            const migrated = await migrateFilesToCharacterFolder(character.name, legacyFileAssets);
            if (migrated.length > 0) {
                // Merge into metadata, preserving tags if the asset already exists
                const byName = new Map((assets || []).map(a => [a.name, a]));
                migrated.forEach((m) => {
                    const existing = byName.get(m.name);
                    if (existing) {
                        m.tags = existing.tags || m.tags || [];
                    }
                    byName.set(m.name, { ...(existing || {}), ...m, tags: m.tags || [] });
                });

                await ContextUtil.saveAssets(getContext().characterId, Array.from(byName.values()));
                invalidateAssetCache();
                await initializeAssetList(popupContainer, character);
            }
        });
        
        // === NEW: Also scan user/images/{characterName}/ directory ===
        // Get known asset names to help with scanning
        const knownNames = assets.map(a => a.name);
        let userImagesAssets = [];
        try {
            userImagesAssets = await scanUserImagesDirectory(character.name, knownNames);
            log(`Found ${userImagesAssets.length} files in user/images/${character.name}/`);
        } catch (e) {
            log('Could not scan user/images/ directory:', e.message);
        }
        
        // Merge all sources: metadata + user/files/ + user/images/
        // Use a canonical key to avoid duplicates between display names vs sanitized filenames.
        const assetMap = new Map(); // canonicalKey -> asset

        function upsertAsset(incoming, { isHighestPriorityUrl = false } = {}) {
            if (!incoming || typeof incoming.name !== 'string') return;
            const key = getCanonicalAssetKey(incoming.name);
            const existing = assetMap.get(key);

            if (!existing) {
                assetMap.set(key, { ...incoming });
                return;
            }

            // Preserve the existing display name (what user uses in %%img:...%%)
            const displayName = existing.name;

            // Merge tags conservatively
            const tags = existing.tags || incoming.tags || [];

            // Merge location; user/images should override user/files
            const urlToUse = isHighestPriorityUrl
                ? (incoming.url || existing.url)
                : (existing.url || incoming.url);

            assetMap.set(key, {
                ...existing,
                ...incoming,
                name: displayName,
                tags,
                url: urlToUse,
                filename: incoming.filename || existing.filename,
                path: incoming.path || existing.path,
                isImageDir: existing.isImageDir || incoming.isImageDir,
            });
        }

        // 1) Metadata first (defines display names + tags)
        assets.forEach((a) => upsertAsset(a));

        // 2) user/files listing (fills URLs if missing)
        fileAssets.forEach((a) => upsertAsset(a));

        // 3) user/images listing (highest priority URL)
        userImagesAssets.forEach((a) => upsertAsset(a, { isHighestPriorityUrl: true }));

        assets = Array.from(assetMap.values());

        // Auto-sync discovered file assets into metadata (and dedupe existing metadata by canonical key).
        // This prevents:
        // - "counted but not rendered" (renderer indexes into metadata)
        // - metadata growth from duplicate names after repeated migrations/imports
        try {
            const rawAssetsBefore = ContextUtil.getAssetsRaw(character) || [];
            const byKey = new Map();
            let changed = false;

            rawAssetsBefore.forEach((a) => {
                if (!a || typeof a.name !== 'string') return;
                const key = getCanonicalAssetKey(a.name);
                if (!byKey.has(key)) {
                    byKey.set(key, { ...a });
                } else {
                    // Deduplicate existing metadata entries: keep the first display name, merge tags/locations.
                    const existing = byKey.get(key);
                    const mergedTags = Array.from(new Set([...(existing.tags || []), ...(a.tags || [])]));
                    byKey.set(key, {
                        ...existing,
                        url: existing.url || a.url,
                        filename: existing.filename || a.filename,
                        path: existing.path || a.path,
                        isImageDir: existing.isImageDir || a.isImageDir,
                        tags: mergedTags,
                    });
                    changed = true;
                }
            });

            for (const a of assets) {
                if (!a || typeof a.name !== 'string' || a.name.trim() === '') continue;
                const key = getCanonicalAssetKey(a.name);
                const existing = byKey.get(key);

                if (!existing) {
                    if (a.url || a.filename || a.path) {
                        byKey.set(key, {
                            name: a.name,
                            filename: a.filename || null,
                            path: a.path || a.filename || null,
                            url: a.url || null,
                            tags: a.tags || [],
                            isImageDir: !!a.isImageDir,
                        });
                        changed = true;
                    }
                    continue;
                }

                // Merge best-known location into existing metadata; preserve display name + tags
                if (a.url && existing.url !== a.url) {
                    existing.url = a.url;
                    changed = true;
                }
                if (a.filename && existing.filename !== a.filename) {
                    existing.filename = a.filename;
                    changed = true;
                }
                if (a.path && existing.path !== a.path) {
                    existing.path = a.path;
                    changed = true;
                }
                if (a.isImageDir && !existing.isImageDir) {
                    existing.isImageDir = true;
                    changed = true;
                }

                // Avoid accidental tag loss
                if (a.tags && a.tags.length > 0 && (!existing.tags || existing.tags.length === 0)) {
                    existing.tags = a.tags;
                    changed = true;
                }
            }

            if (changed) {
                const deduped = Array.from(byKey.values());
                await ContextUtil.saveAssets(getContext().characterId, deduped);
                invalidateAssetCache();
                assets = deduped;
            }
        } catch (e) {
            log('Auto-sync/dedupe of discovered assets into metadata failed:', e.message);
        }
        
        const activeFilterTags = new Set(Array.from(popupContainer.querySelectorAll('.tag-filter.active')).map(el => el.dataset.tag));
        
        updateTagFilters(popupContainer, assets);

        if (!assets || assets.length === 0) {
            gallery.innerHTML = '<div class="inline-assets-placeholder"><p>No images uploaded yet. Drag & drop files here or use the "Upload" button.</p></div>';
            loadMoreDiv.style.display = 'none';
            statusSpan.textContent = '0 assets';
            return;
        }

        // Filter - create a copy of the array to avoid reference issues
        currentPopupAssets = activeFilterTags.size === 0
            ? [...assets]
            : assets.filter(asset => asset.tags && asset.tags.some(tag => activeFilterTags.has(tag)));

        if (currentPopupAssets.length === 0) {
             gallery.innerHTML = '<div class="inline-assets-placeholder"><p>No assets match the current tag filter.</p></div>';
             loadMoreDiv.style.display = 'none';
             statusSpan.textContent = `0 of ${assets.length} assets (filtered)`;
             return;
        }

        statusSpan.textContent = `${currentPopupAssets.length} assets`;

        // Reset Gallery
        gallery.innerHTML = '';
        currentPopupRenderCount = 0;
        
        // Reset selection
        selectedAssets.clear();
        updateSelectionUI(popupContainer);
        
        // Render grouped view
        try {
            renderGroupedAssets(popupContainer, character);
        } catch (error) {
            console.error('[InlineImageAssets] Error rendering assets:', error);
            gallery.innerHTML = `<div class="inline-assets-placeholder"><p>Error loading assets: ${error.message}</p></div>`;
        }
    }

    function renderGroupedAssets(popupContainer, character) {
        const gallery = popupContainer.querySelector('#inline-assets-gallery');
        const loadMoreDiv = popupContainer.querySelector('#inline-assets-load-more');
        const rawAssets = ContextUtil.getAssetsRaw(character);
        
        log('Rendering grouped assets, count:', currentPopupAssets.length);
        
        // Group assets by folder/category name
        const groups = groupAssetsByFolder(currentPopupAssets);
        
        log('Groups created:', groups.size);
        
        // Sort group names alphabetically
        const sortedGroupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
        
        const fragment = document.createDocumentFragment();
        
        sortedGroupNames.forEach(groupName => {
            const groupAssets = groups.get(groupName);
            const isMultiple = groupAssets.length > 1;
            
            // Create folder/group container
            const groupContainer = document.createElement('div');
            groupContainer.className = 'inline-assets-group';
            if (!isMultiple) {
                groupContainer.classList.add('single-item');
            }
            groupContainer.dataset.groupName = groupName;
            
            if (isMultiple) {
                // Folder header for groups with multiple items
                // Start collapsed by default
                groupContainer.classList.add('collapsed');
                
                const folderHeader = document.createElement('div');
                folderHeader.className = 'inline-assets-folder-header';
                folderHeader.innerHTML = `
                    <i class="fa-solid fa-folder"></i>
                    <span class="folder-name">${groupName}</span>
                    <span class="folder-count">(${groupAssets.length})</span>
                    <i class="fa-solid fa-chevron-right folder-toggle"></i>
                `;
                folderHeader.addEventListener('click', () => {
                    groupContainer.classList.toggle('collapsed');
                    const toggleIcon = folderHeader.querySelector('.folder-toggle');
                    toggleIcon.classList.toggle('fa-chevron-down');
                    toggleIcon.classList.toggle('fa-chevron-right');
                });
                groupContainer.appendChild(folderHeader);
            }
            
            // Items container
            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'inline-assets-group-items';
            
            groupAssets.forEach(asset => {
                // Find index by name or canonical key (handles display-name vs sanitized-filename mismatches)
                const assetKey = getCanonicalAssetKey(asset.name);
                const assetIndex = rawAssets.findIndex(a => a.name === asset.name || getCanonicalAssetKey(a.name) === assetKey);
                
                if (assetIndex === -1) {
                    console.warn('[InlineImageAssets] Asset not found in raw assets:', asset.name);
                    return;
                }
                
                const item = document.createElement('div');
                item.className = 'inline-assets-item';
                if (selectedAssets.has(assetIndex)) {
                    item.classList.add('selected');
                }
                
                // Escape HTML in asset name for safety
                const escapedName = asset.name.replace(/"/g, '&quot;');
                
                // Use URL for file-based assets, data for legacy
                const imageSource = asset.url || asset.data || '';
                const isLegacy = !asset.url && asset.data;
                
                item.innerHTML = `
                    <input type="checkbox" class="asset-checkbox" data-index="${assetIndex}" ${selectedAssets.has(assetIndex) ? 'checked' : ''} style="${isSelectionMode ? '' : 'display: none;'}">
                    <img src="${imageSource}" class="inline-assets-item-preview" loading="lazy" data-action="preview" data-index="${assetIndex}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>❌</text></svg>'">
                    ${isLegacy ? '<span class="legacy-badge" title="Legacy base64 asset - consider migrating">Legacy</span>' : ''}
                    <input type="text" class="text_pole inline-assets-item-name" value="${escapedName}" data-index="${assetIndex}">
                    <div class="inline-assets-item-tags">
                        ${(asset.tags || []).map(tag => `<span class="inline-asset-tag" data-index="${assetIndex}" data-tag="${tag}">${tag}<i class="fa-solid fa-times-circle" data-action="delete-tag"></i></span>`).join('')}
                        <input type="text" class="inline-asset-tag-input" placeholder="+ Add tag" data-index="${assetIndex}">
                    </div>
                    <div class="inline-assets-item-actions">
                        <div class="menu_button menu_button_icon" data-action="delete" data-index="${assetIndex}" title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </div>
                    </div>
                `;
                itemsContainer.appendChild(item);
            });
            
            groupContainer.appendChild(itemsContainer);
            fragment.appendChild(groupContainer);
        });
        
        gallery.appendChild(fragment);
        loadMoreDiv.style.display = 'none'; // No pagination needed with grouped view
        
        log('Render complete, gallery children:', gallery.children.length);
    }

    function updateTagFilters(popupContainer, assets) {
        const filterContainer = popupContainer.querySelector('#inline-assets-tag-filter-container');
        const allTags = new Set(assets.flatMap(asset => asset.tags || []));
        const activeFilterTags = new Set(Array.from(filterContainer.querySelectorAll('.tag-filter.active')).map(el => el.dataset.tag));
        
        // Rebuild tags, keeping active status
        filterContainer.innerHTML = '';
        const sortedTags = Array.from(allTags).sort();
        
        sortedTags.forEach(tag => {
            const tagEl = document.createElement('span');
            tagEl.className = 'tag-filter';
            tagEl.dataset.tag = tag;
            tagEl.textContent = tag;
            if (activeFilterTags.has(tag)) tagEl.classList.add('active');
            filterContainer.appendChild(tagEl);
        });
    }

    function createAssetManagerButton() {
        const button = document.createElement('div');
        button.className = 'menu_button menu_button_icon inline-assets-button';
        button.title = 'Manage Inline Image Assets';
        button.innerHTML = '<i class="fa-solid fa-images"></i>';
        button.addEventListener('click', async () => {
            const popupContent = await createAssetManagerPopup();
            if (popupContent) getContext().callPopup(popupContent, 'text', '', { wide: true, large: true });
        });
        return button;
    }

    function injectButton() {
        if (document.querySelector('.inline-assets-button')) return;
        const descriptionDiv = document.querySelector('#description_div');
        if (descriptionDiv) {
            const mediaOverridesButton = descriptionDiv.querySelector('#character_open_media_overrides');
            if (mediaOverridesButton) {
                const assetButton = createAssetManagerButton();
                const altDescButton = descriptionDiv.querySelector('.alt_descriptions_button');
                if (altDescButton) {
                    altDescButton.parentNode.insertBefore(assetButton, altDescButton.nextSibling);
                } else {
                    mediaOverridesButton.parentNode.insertBefore(assetButton, mediaOverridesButton.nextSibling);
                }
            }
        }
    }

    // === PERSONA ASSET MANAGER ===
    
    // Globals for Persona Popup
    let currentPersonaPopupAssets = [];
    let personaSelectedAssets = new Set();
    let isPersonaSelectionMode = false;

    function createPersonaAssetManagerButton() {
        const button = document.createElement('div');
        button.className = 'menu_button menu_button_icon inline-assets-persona-button';
        button.title = 'Manage Persona Inline Image Assets';
        button.innerHTML = '<i class="fa-solid fa-images"></i>';
        button.addEventListener('click', async () => {
            const popupContent = await createPersonaAssetManagerPopup();
            if (popupContent) getContext().callPopup(popupContent, 'text', '', { wide: true, large: true });
        });
        return button;
    }

    function injectPersonaButton() {
        if (document.querySelector('.inline-assets-persona-button')) return;
        
        // Try to find persona controls
        const personaControls = document.querySelector('#persona_controls .persona_controls_buttons_block');
        if (personaControls) {
            const button = createPersonaAssetManagerButton();
            // Insert after persona_lore_button if exists
            const loreButton = personaControls.querySelector('#persona_lore_button');
            if (loreButton) {
                loreButton.parentNode.insertBefore(button, loreButton.nextSibling);
            } else {
                personaControls.appendChild(button);
            }
            log('Persona asset button injected');
        }
    }

    async function createPersonaAssetManagerPopup() {
        const personaName = getCurrentPersonaName();
        if (!personaName) {
            toastr.error("No persona selected.");
            return null;
        }

        const container = document.createElement('div');
        container.className = 'inline-assets-popup-container persona-assets-popup';

        container.innerHTML = `
            <div class="inline-assets-header">
                <h3>Image Assets for Persona: ${personaName}</h3>
                <div class="inline-assets-header-actions">
                    <div id="persona-refresh-assets-btn" class="menu_button menu_button_icon" title="Refresh Assets">
                        <i class="fa-solid fa-sync"></i>
                    </div>
                    <div id="persona-generate-prompt-btn" class="menu_button menu_button_icon" title="Copy Asset List Prompt for Lorebook">
                        <i class="fa-solid fa-file-invoice"></i>
                    </div>
                    <div id="persona-download-zip-btn" class="menu_button menu_button_icon" title="Download All as ZIP">
                        <i class="fa-solid fa-file-zipper"></i>
                    </div>
                    <label class="menu_button menu_button_icon">
                        <i class="fa-solid fa-upload"></i>
                        <span>Upload</span>
                        <input type="file" id="persona-asset-upload-input" multiple accept="image/*,image/webp" style="display: none;">
                    </label>
                </div>
            </div>
            <div class="inline-assets-toolbar">
                <div class="inline-assets-toolbar-left">
                    <i class="fa-solid fa-tags"></i>
                    <div id="persona-inline-assets-tag-filter-container"></div>
                </div>
                <div class="inline-assets-toolbar-right">
                    <div id="persona-toggle-selection-btn" class="menu_button menu_button_icon" title="Toggle Selection Mode">
                        <i class="fa-solid fa-check-square"></i>
                    </div>
                    <div id="persona-select-all-btn" class="menu_button menu_button_icon" title="Select All" style="display: none;">
                        <i class="fa-solid fa-check-double"></i>
                    </div>
                    <div id="persona-delete-selected-btn" class="menu_button menu_button_icon danger" title="Delete Selected" style="display: none;">
                        <i class="fa-solid fa-trash"></i>
                        <span id="persona-selected-count">(0)</span>
                    </div>
                </div>
            </div>
            <div class="inline-assets-status">
                <span id="persona-assets-count">Loading...</span>
            </div>
            <div id="persona-inline-assets-gallery" class="inline-assets-gallery">
                <div class="inline-assets-loading">
                    <i class="fa-solid fa-spinner fa-spin"></i>
                    <span>Loading assets...</span>
                </div>
            </div>
        `;

        const fileInput = container.querySelector('#persona-asset-upload-input');
        const gallery = container.querySelector('#persona-inline-assets-gallery');

        // Drag and drop
        gallery.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            gallery.classList.add('drag-over');
        });
        gallery.addEventListener('dragleave', (e) => {
            e.preventDefault();
            gallery.classList.remove('drag-over');
        });
        gallery.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            gallery.classList.remove('drag-over');
            
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                await handlePersonaFileUpload(files, personaName, container);
            }
        });
        fileInput.addEventListener('change', async (e) => {
            if (e.target.files.length) {
                await handlePersonaFileUpload(e.target.files, personaName, container);
                e.target.value = '';
            }
        });

        // Refresh button
        container.querySelector('#persona-refresh-assets-btn').addEventListener('click', async () => {
            await initializePersonaAssetList(container, personaName);
            toastr.success('Persona assets refreshed');
        });

        // Download ZIP button
        container.querySelector('#persona-download-zip-btn').addEventListener('click', async () => {
            await downloadPersonaAssetsAsZip(personaName, container);
        });

        // Generate prompt button - for lorebook
        container.querySelector('#persona-generate-prompt-btn').addEventListener('click', async () => {
            const assets = getPersonaAssetsRaw(personaName);
            if (assets.length === 0) {
                toastr.info("No assets available.");
                return;
            }
            const compressedNames = compressAssetNames(assets.map(asset => asset.name));
            const promptText = `### {{user}}'s Image Asset Usage Guide

**Overview:**
You have access to pre-defined images for this persona ({{user}}). Use them to visually enhance descriptions of {{user}}'s actions and expressions when appropriate.

**How to Display an Image:**
Use the tag \`%%img:filename%%\` in your response. Do not include the file extension.

**Available Image Filenames:**
${compressedNames}

**Format Guide:**
- \`name_[a, b, c]\` (underscore-separated) → Files exist as \`name_a\`, \`name_b\`, \`name_c\` → Use \`%%img:name_a%%\`
- \`name [a, b, c]\` (space-separated) → Files exist as \`name a\`, \`name b\`, \`name c\` → Use \`%%img:name a%%\`
- \`name.1~3\` → Files exist as \`name.1\`, \`name.2\`, \`name.3\` → Use \`%%img:name.1%%\`

**Note:**
If there are variations in numbers, do not use them consecutively.
These are {{user}}'s (persona's) images - use them when describing {{user}}'s expressions, actions, or appearance.`;
            
            try {
                await navigator.clipboard.writeText(promptText);
                toastr.success("Prompt copied! Paste it into your persona's linked Lorebook entry.");
            } catch (err) {
                toastr.error("Failed to copy.");
            }
        });

        // Selection mode toggle
        container.querySelector('#persona-toggle-selection-btn').addEventListener('click', () => {
            isPersonaSelectionMode = !isPersonaSelectionMode;
            personaSelectedAssets.clear();
            updatePersonaSelectionUI(container);
        });

        // Select all button
        container.querySelector('#persona-select-all-btn').addEventListener('click', () => {
            const assets = getPersonaAssetsRaw(personaName);
            if (personaSelectedAssets.size === assets.length) {
                personaSelectedAssets.clear();
            } else {
                assets.forEach((_, index) => personaSelectedAssets.add(index));
            }
            updatePersonaSelectionUI(container);
        });

        // Delete selected button
        container.querySelector('#persona-delete-selected-btn').addEventListener('click', async () => {
            if (personaSelectedAssets.size === 0) return;
            
            if (confirm(`Are you sure you want to delete ${personaSelectedAssets.size} selected asset(s)?`)) {
                const assets = getPersonaAssetsRaw(personaName);
                const toDelete = Array.from(personaSelectedAssets).sort((a, b) => b - a);
                
                // Delete files
                const filenames = toDelete
                    .map(idx => assets[idx])
                    .filter(asset => asset && asset.filename)
                    .map(asset => asset.filename);
                
                for (const filename of filenames) {
                    await deletePersonaImageFile(personaName, filename);
                }
                
                // Update settings
                const newAssets = assets.filter((_, idx) => !personaSelectedAssets.has(idx));
                await savePersonaAssets(personaName, newAssets);
                
                personaSelectedAssets.clear();
                isPersonaSelectionMode = false;
                
                toastr.success(`Deleted ${toDelete.length} asset(s)`);
                await initializePersonaAssetList(container, personaName);
            }
        });
        
        setupPersonaPopupEventListeners(container, personaName);
        
        // Initial Load
        await initializePersonaAssetList(container, personaName);
        
        return container;
    }

    function updatePersonaSelectionUI(container) {
        const selectAllBtn = container.querySelector('#persona-select-all-btn');
        const deleteSelectedBtn = container.querySelector('#persona-delete-selected-btn');
        const selectedCountSpan = container.querySelector('#persona-selected-count');
        const toggleBtn = container.querySelector('#persona-toggle-selection-btn');
        const gallery = container.querySelector('#persona-inline-assets-gallery');
        
        if (isPersonaSelectionMode) {
            selectAllBtn.style.display = '';
            deleteSelectedBtn.style.display = '';
            toggleBtn.classList.add('active');
            gallery.classList.add('selection-mode');
        } else {
            selectAllBtn.style.display = 'none';
            deleteSelectedBtn.style.display = 'none';
            toggleBtn.classList.remove('active');
            gallery.classList.remove('selection-mode');
        }
        
        selectedCountSpan.textContent = `(${personaSelectedAssets.size})`;
        
        gallery.querySelectorAll('.asset-checkbox').forEach(checkbox => {
            const index = parseInt(checkbox.dataset.index);
            checkbox.checked = personaSelectedAssets.has(index);
        });
    }

    function setupPersonaPopupEventListeners(popupContainer, personaName) {
        const tagFilterContainer = popupContainer.querySelector('#persona-inline-assets-tag-filter-container');
        const gallery = popupContainer.querySelector('#persona-inline-assets-gallery');
        
        // Tag filter click handler
        tagFilterContainer.addEventListener('click', async (event) => {
            const tagFilter = event.target.closest('.tag-filter');
            if (tagFilter) {
                tagFilter.classList.toggle('active');
                await initializePersonaAssetList(popupContainer, personaName);
            }
        }, { passive: true });

        // Gallery click handler
        gallery.addEventListener('click', async (event) => {
            const target = event.target;
            
            // Handle checkbox clicks in selection mode
            const checkbox = target.closest('.asset-checkbox');
            if (checkbox && isPersonaSelectionMode) {
                const index = parseInt(checkbox.dataset.index);
                if (checkbox.checked) {
                    personaSelectedAssets.add(index);
                } else {
                    personaSelectedAssets.delete(index);
                }
                updatePersonaSelectionUI(popupContainer);
                return;
            }
            
            // Handle item click in selection mode
            if (isPersonaSelectionMode) {
                const item = target.closest('.inline-assets-item');
                if (item && !target.closest('input') && !target.closest('.inline-assets-item-actions')) {
                    const checkbox = item.querySelector('.asset-checkbox');
                    if (checkbox) {
                        checkbox.checked = !checkbox.checked;
                        const index = parseInt(checkbox.dataset.index);
                        if (checkbox.checked) {
                            personaSelectedAssets.add(index);
                        } else {
                            personaSelectedAssets.delete(index);
                        }
                        updatePersonaSelectionUI(popupContainer);
                    }
                    return;
                }
            }
            
            const deleteButton = target.closest('[data-action="delete"]');
            const deleteTagButton = target.closest('[data-action="delete-tag"]');
            const previewImage = target.closest('[data-action="preview"]');
            
            if (!deleteButton && !deleteTagButton && !previewImage) return;
            
            event.stopPropagation();
            event.preventDefault();
            
            const assets = getPersonaAssetsRaw(personaName);

            if (previewImage) {
                const index = parseInt(previewImage.dataset.index, 10);
                if (assets[index]) {
                    requestAnimationFrame(() => {
                        const asset = assets[index];
                        const imageSource = asset.url || asset.data;
                        showImagePreview(imageSource, asset.name);
                    });
                }
            } else if (deleteButton) {
                const index = parseInt(deleteButton.dataset.index, 10);
                const asset = assets[index];
                if (confirm(`Are you sure you want to delete the asset "${asset.name}"?`)) {
                    if (asset.filename) {
                        await deletePersonaImageFile(personaName, asset.filename);
                    }
                    
                    assets.splice(index, 1);
                    await savePersonaAssets(personaName, assets);
                    await initializePersonaAssetList(popupContainer, personaName);
                }
            } else if (deleteTagButton) {
                const tagElement = target.closest('.inline-asset-tag');
                const index = parseInt(tagElement.dataset.index, 10);
                const tagToRemove = tagElement.dataset.tag;
                if(assets[index]?.tags) {
                    assets[index].tags = assets[index].tags.filter(t => t !== tagToRemove);
                    await savePersonaAssets(personaName, assets);
                    await initializePersonaAssetList(popupContainer, personaName);
                }
            }
        });

        // Name change handler
        gallery.addEventListener('change', async (event) => {
            if (!event.target.classList.contains('inline-assets-item-name')) return;
            
            const assets = getPersonaAssetsRaw(personaName);
            const index = parseInt(event.target.dataset.index, 10);
            const originalName = assets[index].name;
            const newName = event.target.value.trim();

            if (!newName) {
                toastr.error("Asset name cannot be empty.");
                event.target.value = originalName;
                return;
            }
            if (assets.some((a, i) => i !== index && a.name === newName)) {
                toastr.error(`An asset with the name "${newName}" already exists.`);
                event.target.value = originalName;
                return;
            }
            assets[index].name = newName;
            await savePersonaAssets(personaName, assets);
        });

        // Tag input handler
        gallery.addEventListener('keydown', async (event) => {
            if (!event.target.classList.contains('inline-asset-tag-input') || event.key !== 'Enter') return;
            
            event.preventDefault();
            const newTag = event.target.value.trim().toLowerCase();
            if (newTag) {
                const assets = getPersonaAssetsRaw(personaName);
                const index = parseInt(event.target.dataset.index, 10);
                if (!assets[index].tags) assets[index].tags = [];
                if (!assets[index].tags.includes(newTag)) {
                    assets[index].tags.push(newTag);
                    await savePersonaAssets(personaName, assets);
                    await initializePersonaAssetList(popupContainer, personaName);
                } else {
                    event.target.value = '';
                }
            }
        });
    }

    async function handlePersonaFileUpload(files, personaName, popupContainer) {
        files = Array.from(files);
        if (!files.length) return;
        
        const gallery = popupContainer.querySelector('#persona-inline-assets-gallery');
        const statusSpan = popupContainer.querySelector('#persona-assets-count');
        
        // Validate files
        const validFiles = [];
        const invalidFiles = [];
        
        for (const file of files) {
            const validation = validateImageFile(file);
            if (validation.valid) {
                validFiles.push(file);
            } else {
                invalidFiles.push({ file, reason: validation.reason });
            }
        }
        
        if (invalidFiles.length > 0) {
            invalidFiles.forEach(({ file, reason }) => {
                toastr.warning(`${file.name}: ${reason}`);
            });
        }
        
        if (validFiles.length === 0) {
            if (invalidFiles.length > 0) {
                toastr.error('No valid files to upload.');
            }
            return;
        }
        
        const totalFiles = validFiles.length;
        let completedFiles = 0;
        const updateProgress = () => {
            const percent = Math.round((completedFiles / totalFiles) * 100);
            statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading ${completedFiles}/${totalFiles} (${percent}%)...`;
        };
        updateProgress();
        
        const assets = getPersonaAssetsRaw(personaName);
        const existingNames = new Set(assets.map(asset => asset.name));
        
        if (!csrfDisabled) {
            await fetchCsrfToken();
        }
        
        const filesToUpload = [];
        let skippedUploads = 0;
        
        for (const file of validFiles) {
            const nameWithoutExtension = file.name.substring(0, file.name.lastIndexOf('.'));
            if (existingNames.has(nameWithoutExtension)) {
                skippedUploads++;
                completedFiles++;
            } else {
                filesToUpload.push(file);
                existingNames.add(nameWithoutExtension);
            }
        }
        
        updateProgress();
        
        if (filesToUpload.length === 0) {
            if (skippedUploads > 0) {
                toastr.warning(`Skipped ${skippedUploads} file(s) that already exist.`);
            }
            await initializePersonaAssetList(popupContainer, personaName);
            return;
        }
        
        const CONCURRENT_UPLOADS = 4;
        const results = [];
        
        for (let i = 0; i < filesToUpload.length; i += CONCURRENT_UPLOADS) {
            const batch = filesToUpload.slice(i, i + CONCURRENT_UPLOADS);
            
            const batchPromises = batch.map(async (file) => {
                try {
                    const savedFile = await savePersonaImageFile(personaName, file.name, file);
                    completedFiles++;
                    updateProgress();
                    return { success: true, file: savedFile };
                } catch (error) {
                    console.error(`[InlineImageAssets] Failed to upload persona asset ${file.name}:`, error);
                    completedFiles++;
                    updateProgress();
                    return { success: false, error, fileName: file.name };
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
        }
        
        const newAssets = [];
        let successfulUploads = 0;
        let failedUploads = 0;
        
        for (const result of results) {
            if (result.success) {
                newAssets.push({
                    name: result.file.name,
                    filename: result.file.filename,
                    path: result.file.path,
                    url: result.file.url,
                    tags: []
                });
                successfulUploads++;
            } else {
                failedUploads++;
            }
        }

        if (successfulUploads > 0) {
            const updatedAssets = [...assets, ...newAssets];
            await savePersonaAssets(personaName, updatedAssets);
            toastr.success(`Successfully uploaded ${successfulUploads} file(s).`);
        }
        
        if (failedUploads > 0) {
            toastr.error(`Failed to upload ${failedUploads} file(s).`);
        }
        
        if (skippedUploads > 0) {
            toastr.info(`Skipped ${skippedUploads} file(s) that already exist.`);
        }
        
        await initializePersonaAssetList(popupContainer, personaName);
    }

    async function downloadPersonaAssetsAsZip(personaName, popupContainer) {
        const statusSpan = popupContainer.querySelector('#persona-assets-count');
        const originalStatus = statusSpan.textContent;
        
        try {
            const assets = getPersonaAssetsRaw(personaName);
            
            if (assets.length === 0) {
                toastr.info('No assets to download');
                return;
            }
            
            statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Preparing ZIP (0/${assets.length})...`;
            
            if (typeof JSZip === 'undefined') {
                statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Loading ZIP library...`;
                await loadJSZip();
            }
            
            const zip = new JSZip();
            let downloadedCount = 0;
            let failedCount = 0;
            
            for (const asset of assets) {
                try {
                    const imageUrl = asset.url || asset.data;
                    if (!imageUrl) {
                        failedCount++;
                        continue;
                    }
                    
                    let blob;
                    if (imageUrl.startsWith('data:')) {
                        blob = base64ToBlob(imageUrl);
                    } else {
                        const response = await fetch(imageUrl);
                        if (!response.ok) {
                            failedCount++;
                            continue;
                        }
                        blob = await response.blob();
                    }
                    
                    let filename = asset.filename || asset.name;
                    if (!filename.includes('.')) {
                        const ext = getExtensionFromMime(blob.type);
                        filename = `${filename}.${ext}`;
                    }
                    
                    zip.file(filename, blob);
                    downloadedCount++;
                    
                    statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Preparing ZIP (${downloadedCount}/${assets.length})...`;
                } catch (error) {
                    console.error(`[InlineImageAssets] Failed to add ${asset.name} to ZIP:`, error);
                    failedCount++;
                }
            }
            
            if (downloadedCount === 0) {
                toastr.error('No assets could be downloaded');
                statusSpan.textContent = originalStatus;
                return;
            }
            
            statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating ZIP file...`;
            
            const zipBlob = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 }
            }, (metadata) => {
                const percent = Math.round(metadata.percent);
                statusSpan.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Compressing... ${percent}%`;
            });
            
            const sanitizedName = sanitizeFilename(personaName);
            const downloadName = `${sanitizedName}_persona_assets.zip`;
            
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            statusSpan.textContent = originalStatus;
            
            if (failedCount > 0) {
                toastr.warning(`Downloaded ${downloadedCount} assets, ${failedCount} failed`);
            } else {
                toastr.success(`Downloaded ${downloadedCount} assets as ZIP`);
            }
        } catch (error) {
            console.error('[InlineImageAssets] Persona ZIP download failed:', error);
            toastr.error('Failed to create ZIP file');
            statusSpan.textContent = originalStatus;
        }
    }

    async function initializePersonaAssetList(popupContainer, personaName) {
        const gallery = popupContainer.querySelector('#persona-inline-assets-gallery');
        const statusSpan = popupContainer.querySelector('#persona-assets-count');
        
        gallery.innerHTML = `
            <div class="inline-assets-loading">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <span>Loading assets...</span>
            </div>
        `;
        
        // Get assets from settings
        let assets = getPersonaAssetsRaw(personaName);
        
        // Also try to load from file system
        const fileAssets = await listPersonaImages(personaName);
        
        // Merge sources
        const assetMap = new Map();
        
        assets.forEach(a => assetMap.set(a.name, a));
        
        fileAssets.forEach(a => {
            if (!assetMap.has(a.name)) {
                assetMap.set(a.name, a);
            } else {
                const existing = assetMap.get(a.name);
                if (!existing.url && a.url) {
                    existing.url = a.url;
                    existing.filename = a.filename;
                    existing.path = a.path;
                }
            }
        });
        
        assets = Array.from(assetMap.values());
        
        const filterContainer = popupContainer.querySelector('#persona-inline-assets-tag-filter-container');
        const activeFilterTags = new Set(Array.from(filterContainer.querySelectorAll('.tag-filter.active')).map(el => el.dataset.tag));
        
        // Update tag filters
        const allTags = new Set(assets.flatMap(asset => asset.tags || []));
        filterContainer.innerHTML = '';
        const sortedTags = Array.from(allTags).sort();
        sortedTags.forEach(tag => {
            const tagEl = document.createElement('span');
            tagEl.className = 'tag-filter';
            tagEl.dataset.tag = tag;
            tagEl.textContent = tag;
            if (activeFilterTags.has(tag)) tagEl.classList.add('active');
            filterContainer.appendChild(tagEl);
        });

        if (!assets || assets.length === 0) {
            gallery.innerHTML = '<div class="inline-assets-placeholder"><p>No images uploaded yet. Drag & drop files here or use the "Upload" button.</p></div>';
            statusSpan.textContent = '0 assets';
            return;
        }

        currentPersonaPopupAssets = activeFilterTags.size === 0
            ? [...assets]
            : assets.filter(asset => asset.tags && asset.tags.some(tag => activeFilterTags.has(tag)));

        if (currentPersonaPopupAssets.length === 0) {
            gallery.innerHTML = '<div class="inline-assets-placeholder"><p>No assets match the current tag filter.</p></div>';
            statusSpan.textContent = `0 of ${assets.length} assets (filtered)`;
            return;
        }

        statusSpan.textContent = `${currentPersonaPopupAssets.length} assets`;

        gallery.innerHTML = '';
        
        personaSelectedAssets.clear();
        updatePersonaSelectionUI(popupContainer);
        
        // Render grouped view
        try {
            renderPersonaGroupedAssets(popupContainer, personaName, assets);
        } catch (error) {
            console.error('[InlineImageAssets] Error rendering persona assets:', error);
            gallery.innerHTML = `<div class="inline-assets-placeholder"><p>Error loading assets: ${error.message}</p></div>`;
        }
    }

    function renderPersonaGroupedAssets(popupContainer, personaName, rawAssets) {
        const gallery = popupContainer.querySelector('#persona-inline-assets-gallery');
        
        const groups = groupAssetsByFolder(currentPersonaPopupAssets);
        const sortedGroupNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
        
        const fragment = document.createDocumentFragment();
        
        sortedGroupNames.forEach(groupName => {
            const groupAssets = groups.get(groupName);
            const isMultiple = groupAssets.length > 1;
            
            const groupContainer = document.createElement('div');
            groupContainer.className = 'inline-assets-group';
            if (!isMultiple) {
                groupContainer.classList.add('single-item');
            }
            groupContainer.dataset.groupName = groupName;
            
            if (isMultiple) {
                groupContainer.classList.add('collapsed');
                
                const folderHeader = document.createElement('div');
                folderHeader.className = 'inline-assets-folder-header';
                folderHeader.innerHTML = `
                    <i class="fa-solid fa-folder"></i>
                    <span class="folder-name">${groupName}</span>
                    <span class="folder-count">(${groupAssets.length})</span>
                    <i class="fa-solid fa-chevron-right folder-toggle"></i>
                `;
                folderHeader.addEventListener('click', () => {
                    groupContainer.classList.toggle('collapsed');
                    const toggleIcon = folderHeader.querySelector('.folder-toggle');
                    toggleIcon.classList.toggle('fa-chevron-down');
                    toggleIcon.classList.toggle('fa-chevron-right');
                });
                groupContainer.appendChild(folderHeader);
            }
            
            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'inline-assets-group-items';
            
            groupAssets.forEach(asset => {
                const assetIndex = rawAssets.findIndex(a => a.name === asset.name);
                
                if (assetIndex === -1) {
                    console.warn('[InlineImageAssets] Persona asset not found:', asset.name);
                    return;
                }
                
                const item = document.createElement('div');
                item.className = 'inline-assets-item';
                if (personaSelectedAssets.has(assetIndex)) {
                    item.classList.add('selected');
                }
                
                const escapedName = asset.name.replace(/"/g, '&quot;');
                const imageSource = asset.url || asset.data || '';
                
                item.innerHTML = `
                    <input type="checkbox" class="asset-checkbox" data-index="${assetIndex}" ${personaSelectedAssets.has(assetIndex) ? 'checked' : ''} style="${isPersonaSelectionMode ? '' : 'display: none;'}">
                    <img src="${imageSource}" class="inline-assets-item-preview" loading="lazy" data-action="preview" data-index="${assetIndex}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>❌</text></svg>'">
                    <input type="text" class="text_pole inline-assets-item-name" value="${escapedName}" data-index="${assetIndex}">
                    <div class="inline-assets-item-tags">
                        ${(asset.tags || []).map(tag => `<span class="inline-asset-tag" data-index="${assetIndex}" data-tag="${tag}">${tag}<i class="fa-solid fa-times-circle" data-action="delete-tag"></i></span>`).join('')}
                        <input type="text" class="inline-asset-tag-input" placeholder="+ Add tag" data-index="${assetIndex}">
                    </div>
                    <div class="inline-assets-item-actions">
                        <div class="menu_button menu_button_icon" data-action="delete" data-index="${assetIndex}" title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </div>
                    </div>
                `;
                itemsContainer.appendChild(item);
            });
            
            groupContainer.appendChild(itemsContainer);
            fragment.appendChild(groupContainer);
        });
        
        gallery.appendChild(fragment);
    }
    
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), wait);
        };
    }

    // Batched mutation handler to prevent excessive processing (for assets)
    let mutationBatch = [];
    let mutationTimeout = null;
    
    function processMutationBatch() {
        // Skip if asset rendering is not active
        if (!isAssetRenderingActive) {
            mutationBatch = [];
            return;
        }
        
        const uniqueMessages = new Set();
        
        for (const mutation of mutationBatch) {
            let targetNode = mutation.target;
            if (targetNode.nodeType === Node.TEXT_NODE) {
                targetNode = targetNode.parentElement;
            }
            
            if (!targetNode) continue;
            
            const messageElement = targetNode.closest('.mes');
            if (messageElement) {
                // Check if content has %%img: tags - if so, always re-process
                const textElement = messageElement.querySelector('.mes_text');
                if (textElement) {
                    const html = textElement.innerHTML;
                    if (html.includes('%%img:')) {
                        // Has image tags - check if they're already converted
                        if (!html.includes('<img') || html.includes('%%img:')) {
                            // Not fully converted yet, need to process
                            uniqueMessages.add(messageElement);
                            // Remove from processed set to allow re-processing
                            // (WeakSet doesn't have delete, but we can just add to queue)
                        }
                    }
                }
                
                // Also add if not processed at all
                if (!processedMessages.has(messageElement)) {
                    uniqueMessages.add(messageElement);
                }
            }
            
            // Handle newly added messages
            if (mutation.addedNodes.length > 0) {
                for (const addedNode of mutation.addedNodes) {
                    if (addedNode.nodeType === Node.ELEMENT_NODE) {
                        if (addedNode.matches?.('.mes')) {
                            // New message - always process
                            uniqueMessages.add(addedNode);
                            log('New message detected via mutation:', addedNode.getAttribute('mesid'));
                        } else if (addedNode.querySelectorAll) {
                            // Check for nested .mes elements
                            const nestedMessages = addedNode.querySelectorAll('.mes');
                            nestedMessages.forEach(msg => {
                                uniqueMessages.add(msg);
                                log('Nested new message detected:', msg.getAttribute('mesid'));
                            });
                        }
                    }
                }
            }
        }
        
        mutationBatch = [];
        
        // Queue unique messages for rendering
        for (const msg of uniqueMessages) {
            // Force re-processing by removing from processed set conceptually
            // Since WeakSet doesn't have delete, we need a different approach
            queueMessageForRenderForce(msg);
        }
    }
    
    /**
     * Force queue a message for rendering, bypassing the processed check
     */
    function queueMessageForRenderForce(messageElement) {
        // Skip if asset rendering is not active
        if (!isAssetRenderingActive) return;
        
        // Remove from noImageTagMessages if it was there (content may have changed)
        // WeakSet doesn't have delete, so we just proceed
        
        if (!renderQueue.includes(messageElement)) {
            renderQueue.push(messageElement);
            scheduleRender();
        }
    }
    
    function onUiLoaded() {
        injectButton();
        injectPersonaButton();

        const chatElement = document.getElementById('chat');
        if(chatElement) {
            // ALWAYS initialize performance booster (for ALL characters)
            initializePerformanceBooster();
            
            // Check if current character has assets for asset rendering
            updateAssetRenderingState();
        }
        
        eventSource.on(event_types.CHARACTER_SELECTED, () => {
            // Invalidate asset cache when character changes
            invalidateAssetCache();
            
            // Re-apply performance booster and check assets
            setTimeout(() => {
                applyContentVisibility(); // Refresh content visibility hints
                updateAssetRenderingState();
                injectButton();
                injectPersonaButton();
            }, 200);
        });
        
        // Listen for persona changes
        eventSource.on(event_types.SETTINGS_UPDATED, () => {
            // Persona might have changed - invalidate persona cache
            invalidatePersonaAssetCache();
            setTimeout(() => {
                injectPersonaButton();
            }, 200);
        });
        
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Clear asset processing tracking for new chat
            renderQueue = [];
            mutationBatch = [];
            
            // Reset processed message tracking (WeakSet has no clear method)
            processedMessages = new WeakSet();
            noImageTagMessages = new WeakSet();
            
            // Reset asset visibility observer
            if (visibilityObserver) {
                visibilityObserver.disconnect();
                visibilityObserver = null;
            }
            
            // Re-apply performance booster and check assets
            setTimeout(() => {
                applyContentVisibility(); // Refresh content visibility hints
                updateAssetRenderingState();
            }, 100);
        });

        console.log('[InlineImageAssets] File System Based v5.1 Loaded.');
        console.log('[InlineImageAssets] Global Performance Booster: ALWAYS ACTIVE');
        console.log('[InlineImageAssets] Persona Asset Support: ENABLED');
        console.log(`[InlineImageAssets] Asset Rendering: ${isAssetRenderingActive ? 'ACTIVE' : 'DORMANT'}`);
    }

    const interval = setInterval(() => {
        if (document.querySelector('#description_div #character_open_media_overrides')) {
            clearInterval(interval);
            setTimeout(onUiLoaded, 500);
        }
    }, 100);

    // Also try to inject persona button when persona panel becomes available
    const personaInterval = setInterval(() => {
        if (document.querySelector('#persona_controls .persona_controls_buttons_block')) {
            clearInterval(personaInterval);
            setTimeout(injectPersonaButton, 500);
        }
    }, 500);

})();