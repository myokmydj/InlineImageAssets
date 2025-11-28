/*
 * Inline Image Assets Extension for SillyTavern
 * OPTIMIZED VERSION: Fixes memory leaks with large asset libraries (>500 images).
 * 1. Removes unnecessary data copying in renderMessage (huge memory saver).
 * 2. Implements lazy loading (pagination) for the asset gallery popup.
 */
import { getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";

(function () {
    const DEBUG = false;
    const log = (message, ...args) => {
        if (DEBUG) console.log(`[InlineImageAssets:DEBUG] ${message}`, ...args);
    };

    // Captures content between %%img: and %%
    const tagRegex = /%%img:([^%]+)%%/g;

    class ContextUtil {
        static getCharacterFromData(message, context) {
            // Optimization: Don't search if user message
            if (message.is_user) return null;
            // Direct lookup if possible, fallback to find
            if (context.characters && context.characterId !== undefined) {
                 // Assuming the current chat belongs to the current character mostly
                 // Ideally we strictly match names, but for speed we access current char first
                 const current = context.characters[context.characterId];
                 if (current && current.name === message.name) return current;
            }
            const character = context.characters.find(c => c.name === message.name);
            return character;
        }

        // Optimized: Returns reference to array, DOES NOT CLONE deep data unless needed
        static getAssetsRaw(character) {
            if (character && character.data.extensions) {
                return character.data.extensions.inline_image_assets_b64 || [];
            }
            return [];
        }

        static async saveAssets(characterId, assets) {
            getContext().writeExtensionField(characterId, 'inline_image_assets_b64', assets);
        }
    }

    const debouncedRender = debounce(renderMessage, 50);

    async function renderMessage(messageElement) {
        if (messageElement.dataset.rendering || !messageElement.closest('#chat')) {
            return;
        }

        const mesId = parseInt(messageElement.getAttribute('mesid'));
        if (isNaN(mesId)) return;

        const context = getContext();
        const message = context.chat[mesId];
        if (!message || message.is_user) return;
        
        const textElement = messageElement.querySelector('.mes_text');
        if (!textElement) return;

        // Quick check before heavy lifting
        if (!textElement.innerHTML.includes('%%img:')) return;

        log(`Rendering mesId ${mesId}`);

        const character = ContextUtil.getCharacterFromData(message, context);
        if (!character) return;

        // PERFORMANCE FIX: Do NOT map/clone the entire asset list.
        // Just get the reference.
        const assets = ContextUtil.getAssetsRaw(character);
        if (!assets || assets.length === 0) return;

        messageElement.dataset.rendering = 'true';

        let processedHtml = textElement.innerHTML;
        let modified = false;

        // Use replace function directly to find matches.
        // Instead of creating a Map of 500 images (Huge Memory Cost),
        // we iterate the 500 items only when a tag is found (CPU Cost, but prevents Crash).
        const finalHtml = processedHtml.replace(tagRegex, (match, assetName) => {
            const trimmedName = assetName.trim();
            // Find the specific asset only when needed
            const asset = assets.find(a => a.name === trimmedName);
            
            if (asset && asset.data) {
                modified = true;
                return `<img src='${asset.data}' alt='${trimmedName}' class='inline-asset-image'>`;
            }
            return match;
        });

        if (modified) {
            textElement.innerHTML = finalHtml;
        }
        
        setTimeout(() => {
            delete messageElement.dataset.rendering;
        }, 0);
    }

    // --- Popup and Asset Management ---
    
    // Globals for Popup Pagination
    let currentPopupAssets = [];
    let currentPopupRenderCount = 0;
    const ASSETS_PER_PAGE = 50; // Render 50 at a time to prevent freeze

    function createAssetManagerPopup() {
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
                    <div id="generate-prompt-btn" class="menu_button menu_button_icon" title="Copy Asset List Prompt">
                        <i class="fa-solid fa-file-invoice"></i>
                    </div>
                    <label class="menu_button menu_button_icon">
                        <i class="fa-solid fa-upload"></i>
                        <span>Upload</span>
                        <input type="file" id="asset-upload-input" multiple accept="image/*,image/webp" style="display: none;">
                    </label>
                </div>
            </div>
            <div class="inline-assets-toolbar">
                <i class="fa-solid fa-tags"></i>
                <div id="inline-assets-tag-filter-container"></div>
            </div>
            <div id="inline-assets-gallery" class="inline-assets-gallery"></div>
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

        gallery.addEventListener('dragover', (e) => { e.preventDefault(); gallery.classList.add('drag-over'); });
        gallery.addEventListener('dragleave', () => gallery.classList.remove('drag-over'));
        gallery.addEventListener('drop', (e) => {
            e.preventDefault();
            gallery.classList.remove('drag-over');
            if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files, character, container);
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) {
                handleFileUpload(e.target.files, character, container);
                e.target.value = '';
            }
        });

        container.querySelector('#generate-prompt-btn').addEventListener('click', async () => {
            const assets = ContextUtil.getAssetsRaw(character);
            if (assets.length === 0) {
                toastr.info("No assets available.");
                return;
            }
            const assetNames = assets.map(asset => `"${asset.name}"`).join(', ');
            const promptText = `[System note: You have access to a set of pre-defined images for this character. To display an image, use the tag %%img:filename%% in your response. Do not include the file extension. Available image filenames are: ${assetNames}. Use them to visually enhance your descriptions and actions when appropriate. If there are variations in numbers, do not use them consecutively.]`;
            
            try {
                await navigator.clipboard.writeText(promptText);
                toastr.success("Prompt copied!");
            } catch (err) {
                toastr.error("Failed to copy.");
            }
        });
        
        setupPopupEventListeners(container, character);
        
        // Initial Load
        initializeAssetList(container, character);
        
        return container;
    }

    function setupPopupEventListeners(popupContainer, character) {
        popupContainer.querySelector('#inline-assets-tag-filter-container').onclick = (event) => {
            if (event.target.classList.contains('tag-filter')) {
                event.target.classList.toggle('active');
                // Re-initialize list on filter change
                initializeAssetList(popupContainer, character);
            }
        };

        const gallery = popupContainer.querySelector('#inline-assets-gallery');
        gallery.onclick = async (event) => {
            const context = getContext();
            const target = event.target;
            const deleteButton = target.closest('[data-action="delete"]');
            const deleteTagButton = target.closest('[data-action="delete-tag"]');

            // Optimization: operate on RAW array reference to avoid full copy
            const assets = ContextUtil.getAssetsRaw(character);

            if (deleteButton) {
                event.stopPropagation();
                const index = parseInt(deleteButton.dataset.index, 10);
                if (confirm(`Are you sure you want to delete the asset "${assets[index].name}"?`)) {
                    assets.splice(index, 1);
                    await ContextUtil.saveAssets(context.characterId, assets);
                    initializeAssetList(popupContainer, character);
                }
            } else if (deleteTagButton) {
                event.stopPropagation();
                const tagElement = target.closest('.inline-asset-tag');
                const index = parseInt(tagElement.dataset.index, 10);
                const tagToRemove = tagElement.dataset.tag;
                if(assets[index].tags) {
                    assets[index].tags = assets[index].tags.filter(t => t !== tagToRemove);
                    await ContextUtil.saveAssets(context.characterId, assets);
                    // Only re-render if strictly needed or just update DOM (re-render for safety)
                    initializeAssetList(popupContainer, character);
                }
            }
        };

        gallery.onchange = async (event) => {
            if (event.target.classList.contains('inline-assets-item-name')) {
                const context = getContext();
                const assets = ContextUtil.getAssetsRaw(character);
                const index = parseInt(event.target.dataset.index, 10);
                let originalName = assets[index].name;
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
            }
        };

        gallery.onkeydown = async (event) => {
            if (event.target.classList.contains('inline-asset-tag-input') && event.key === 'Enter') {
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
                        initializeAssetList(popupContainer, character);
                    } else {
                        event.target.value = '';
                    }
                }
            }
        };
    }

    async function handleFileUpload(files, character, popupContainer) {
        files = Array.from(files);
        if (!files.length) return;
        toastr.info(`Processing ${files.length} image(s)...`);
        
        const assets = ContextUtil.getAssetsRaw(character);
        const existingNames = new Set(assets.map(asset => asset.name));
        
        let successfulUploads = 0, failedUploads = 0, skippedUploads = 0;
        
        // Process sequentially or in smaller chunks to avoid freezing UI
        const processFile = (file) => new Promise((resolve) => {
            const nameWithoutExtension = file.name.substring(0, file.name.lastIndexOf('.'));
            if (existingNames.has(nameWithoutExtension)) {
                skippedUploads++;
                resolve(null);
                return;
            }
            const reader = new FileReader();
            reader.onload = () => resolve({ name: nameWithoutExtension, data: reader.result, tags: [] });
            reader.onerror = () => resolve({ error: true });
            reader.readAsDataURL(file);
        });

        const newAssets = [];
        for (const file of files) {
            const result = await processFile(file);
            if (result && !result.error) {
                newAssets.push(result);
                existingNames.add(result.name);
                successfulUploads++;
            } else if (result && result.error) {
                failedUploads++;
            }
        }

        if (successfulUploads > 0) {
            // Push new items
            assets.push(...newAssets);
            await ContextUtil.saveAssets(getContext().characterId, assets);
            toastr.success(`${successfulUploads} asset(s) added.`);
        }
        if (failedUploads > 0) toastr.error(`${failedUploads} asset(s) failed.`);
        if (skippedUploads > 0) toastr.warning(`${skippedUploads} asset(s) skipped (already exist).`);
        
        initializeAssetList(popupContainer, character);
    }

    // Prepares the filtered list and resets pagination
    function initializeAssetList(popupContainer, character) {
        const gallery = popupContainer.querySelector('#inline-assets-gallery');
        const loadMoreDiv = popupContainer.querySelector('#inline-assets-load-more');
        
        const assets = ContextUtil.getAssetsRaw(character);
        const activeFilterTags = new Set(Array.from(popupContainer.querySelectorAll('.tag-filter.active')).map(el => el.dataset.tag));
        
        updateTagFilters(popupContainer, assets);

        if (assets.length === 0) {
            gallery.innerHTML = '<div class="inline-assets-placeholder"><p>No images uploaded yet. Drag & drop files here or use the "Upload" button.</p></div>';
            loadMoreDiv.style.display = 'none';
            return;
        }

        // Filter
        currentPopupAssets = activeFilterTags.size === 0 
            ? assets 
            : assets.filter(asset => asset.tags && asset.tags.some(tag => activeFilterTags.has(tag)));

        if (currentPopupAssets.length === 0) {
             gallery.innerHTML = '<div class="inline-assets-placeholder"><p>No assets match the current tag filter.</p></div>';
             loadMoreDiv.style.display = 'none';
             return;
        }

        // Reset Gallery
        gallery.innerHTML = '';
        currentPopupRenderCount = 0;
        
        // Render first batch
        renderNextBatch(popupContainer, character);
    }

    function renderNextBatch(popupContainer, character) {
        const gallery = popupContainer.querySelector('#inline-assets-gallery');
        const loadMoreDiv = popupContainer.querySelector('#inline-assets-load-more');
        const rawAssets = ContextUtil.getAssetsRaw(character); // Need this to find original index

        const start = currentPopupRenderCount;
        const end = Math.min(start + ASSETS_PER_PAGE, currentPopupAssets.length);
        const batch = currentPopupAssets.slice(start, end);

        if (batch.length === 0) {
            loadMoreDiv.style.display = 'none';
            return;
        }

        const fragment = document.createDocumentFragment();

        batch.forEach((asset) => {
            // IMPORTANT: Find the REAL index in the main array for delete/edit actions
            // Since we might be viewing a filtered subset.
            const assetIndex = rawAssets.indexOf(asset); 
            
            const item = document.createElement('div');
            item.className = 'inline-assets-item';
            
            // Use data-src or just src, here using src is inevitable for display
            // But creating elements in fragment first is slightly faster
            item.innerHTML = `
                <img src="${asset.data}" class="inline-assets-item-preview" loading="lazy">
                <input type="text" class="text_pole inline-assets-item-name" value="${asset.name}" data-index="${assetIndex}">
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
            fragment.appendChild(item);
        });

        gallery.appendChild(fragment);
        currentPopupRenderCount = end;

        // Show/Hide Load More Button
        if (currentPopupRenderCount >= currentPopupAssets.length) {
            loadMoreDiv.style.display = 'none';
        } else {
            loadMoreDiv.style.display = 'block';
        }
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
        button.addEventListener('click', () => {
            const popupContent = createAssetManagerPopup();
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
    
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), wait);
        };
    }
    
    function onUiLoaded() {
        injectButton();
        
        const chatObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                let targetNode = mutation.target;
                if (targetNode.nodeType === Node.TEXT_NODE) {
                    targetNode = targetNode.parentElement;
                }
                const messageElement = targetNode.closest('.mes');
                if (messageElement) {
                    debouncedRender(messageElement);
                } else if (mutation.addedNodes.length > 0) {
                    for (const addedNode of mutation.addedNodes) {
                        if (addedNode.nodeType === Node.ELEMENT_NODE && addedNode.matches('.mes')) {
                            debouncedRender(addedNode);
                        }
                    }
                }
            }
        });

        const chatElement = document.getElementById('chat');
        if(chatElement) {
            document.querySelectorAll('#chat .mes').forEach(renderMessage);
            chatObserver.observe(chatElement, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        }
        
        eventSource.on(event_types.CHARACTER_SELECTED, () => setTimeout(injectButton, 200));
        eventSource.on(event_types.CHAT_CHANGED, () => {
             setTimeout(() => document.querySelectorAll('#chat .mes').forEach(renderMessage), 200);
        });

        console.log('[InlineImageAssets] Optimized Version Loaded.');
    }

    const interval = setInterval(() => {
        if (document.querySelector('#description_div #character_open_media_overrides')) {
            clearInterval(interval);
            setTimeout(onUiLoaded, 500);
        }
    }, 100);

})();