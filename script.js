const restaurantConfig = window.WASSA_CONFIG || {
    mode: 'demo',
    apiBaseUrl: '',
    name: 'Le WASSA',
    currency: 'FCFA',
    defaultTableId: '',
    demoTables: ['01', '02', '03', '04', '05'],
    loyalty: { pointsPerThousand: 1, rewardThreshold: 100 }
};

const STORAGE_KEYS = {
    cart: 'wassa_cart',
    orders: 'wassa_orders',
    points: 'wassa_loyalty_points',
    table: 'wassa_active_table'
};

let productCatalog = [
    { id: 'poulet-braise', name: 'Poulet braisé', category: 'Grillades', price: 12000, description: 'Poulet mariné aux épices africaines, servi avec alloco et sauce maison.', image: 'images/grillade.png', badge: 'Signature' },
    { id: 'poisson-braise', name: 'Poisson braisé', category: 'Grillades', price: 15000, description: 'Poisson gras grillé au feu de bois, accompagnements maison.', image: 'images/grillade.png', badge: 'Spécialité' },
    { id: 'attieke-poisson', name: 'Attiéké poisson', category: 'Grillades', price: 11000, description: 'Attiéké léger, poisson de mer, tomate, oignon et piment.', image: 'images/grillade.png', badge: 'Populaire' },
    { id: 'kedjenou', name: 'Kedjenou de poulet', category: 'Grillades', price: 14000, description: 'Poulet mijoté aux légumes et épices locales.', image: 'images/grillade.png', badge: 'Chef' },
    { id: 'alloco', name: 'Alloco', category: 'Accompagnements', price: 5000, description: 'Plantain frit, sauce piquante et oignons frais.', image: 'images/grillade.png', badge: 'Accompagnement' },
    { id: 'riz-sauce', name: 'Riz sauce', category: 'Accompagnements', price: 6000, description: 'Riz parfumé et sauce généreuse aux saveurs locales.', image: 'images/grillade.png', badge: 'Classique' },
    { id: 'coca-cola', name: 'Coca-Cola', category: 'Boissons', price: 1500, description: 'Boisson rafraîchissante glacée.', image: 'images/bar.png', badge: 'Boisson' },
    { id: 'jus-mangue', name: 'Jus de mangue', category: 'Boissons', price: 3000, description: 'Jus frais à base de mangue locale.', image: 'images/bar.png', badge: 'Frais' },
    { id: 'tropical-sun', name: 'Tropical Sun', category: 'Boissons', price: 3500, description: 'Mocktail exotique avec fruits tropicaux.', image: 'images/bar.png', badge: 'Nouveau' },
    { id: 'dessert-exotique', name: 'Dessert exotique', category: 'Desserts', price: 8000, description: 'Fruits frais, glace coco et coulis de mangue.', image: 'images/grillade.png', badge: 'Signature' }
];

const API_BASE_URL = restaurantConfig.apiBaseUrl ||
    ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:5173' : '');

const normalizeProduct = (product = {}) => ({
    id: product.id || product.productId || String(product.name || '').toLowerCase().replace(/\s+/g, '-'),
    name: product.name || 'Produit',
    category: product.category || 'Autres',
    price: Number(product.price || 0),
    description: product.description || 'Produit du maquis.',
    image: product.image || 'images/profil.png',
    badge: product.badge || 'Menu'
});

const apiRequest = async (url, options = {}) => {
    const response = await fetch(`${API_BASE_URL}${url}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let data;
    try {
        data = await response.json();
    } catch (error) {
        throw new Error('Le serveur a renvoyé une réponse illisible.');
    }
    if (!response.ok || (data && data.ok === false)) {
        throw new Error(data && data.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : `Erreur serveur (${response.status}).`);
    }
    return data;
};

const loadMenuFromApi = async () => {
    try {
        const response = await apiRequest('/api/menu', { method: 'GET' });
        if (response && response.ok && Array.isArray(response.data)) {
            productCatalog = response.data.map(normalizeProduct);
            renderMenuProducts(document.querySelector('.filter-btn.active')?.dataset.category || 'all');
            return true;
        }
    } catch (error) {
        console.warn('API menu unavailable; showing the configured local catalogue:', error.message);
        productCatalog = productCatalog.length ? productCatalog : [
            { id: 'poulet-braise', name: 'Poulet braisé', category: 'Grillades', price: 12000, description: 'Poulet mariné aux épices africaines, servi avec alloco et sauce maison.', image: 'images/profil.png', badge: 'Signature' },
            { id: 'coca-cola', name: 'Coca-Cola', category: 'Boissons', price: 1500, description: 'Boisson rafraîchissante glacée.', image: 'images/profil.png', badge: 'Boisson' }
        ];
    }
    return false;
};

// Header scroll effect
// Helpers
const $id = id => document.getElementById(id);
const qAll = selector => Array.from(document.querySelectorAll(selector));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const setContactItem = (element, kind, value) => {
    const icon = element.querySelector('i');
    element.replaceChildren(...(icon ? [icon] : []));
    if (!value) {
        element.hidden = true;
        return;
    }
    element.hidden = false;
    const content = document.createElement(kind === 'phone' || kind === 'email' ? 'a' : 'span');
    content.textContent = value;
    if (kind === 'phone') content.href = `tel:${value.replace(/[^\d+]/g, '')}`;
    if (kind === 'email') content.href = `mailto:${value}`;
    element.appendChild(content);
};

const initRestaurantConfig = () => {
    qAll('.logo h1, footer .footer-col:first-child h3').forEach(heading => {
        heading.textContent = restaurantConfig.name || 'Le WASSA';
    });
    document.title = document.title.replace(/Élégance Chic/g, restaurantConfig.name || 'Le WASSA');
    qAll('.footer-bottom p').forEach(copyright => {
        copyright.textContent = `© ${new Date().getFullYear()} ${restaurantConfig.name || 'Le WASSA'}. Tous droits réservés.`;
    });

    qAll('.footer-contact-item:not([id]), .contact-info .contact-item').forEach(item => {
        const icon = item.querySelector('i');
        if (icon?.classList.contains('fa-phone-alt')) setContactItem(item, 'phone', restaurantConfig.phone);
        else if (icon?.classList.contains('fa-envelope')) setContactItem(item, 'email', restaurantConfig.email);
        else if (icon?.classList.contains('fa-map-marker-alt')) setContactItem(item, 'address', restaurantConfig.address);
        else if (icon?.classList.contains('fa-clock')) setContactItem(item, 'hours', (restaurantConfig.openingHours || []).join(' · '));
    });

    const address = $id('restaurant-address');
    const map = $id('restaurant-map');
    const directions = $id('directions-link');
    if (address) address.textContent = restaurantConfig.address || 'Adresse à renseigner dans restaurant-config.js.';
    if (Number.isFinite(restaurantConfig.latitude) && Number.isFinite(restaurantConfig.longitude)) {
        const { latitude: lat, longitude: lon } = restaurantConfig;
        if (map) {
            map.src = `https://www.openstreetmap.org/export/embed.html?bbox=${lon - 0.01}%2C${lat - 0.01}%2C${lon + 0.01}%2C${lat + 0.01}&layer=mapnik&marker=${lat}%2C${lon}`;
            map.hidden = false;
        }
        if (directions) {
            directions.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
            directions.hidden = false;
        }
    }

    const socials = restaurantConfig.socialLinks || {};
    qAll('.footer-social-links a').forEach(link => {
        const label = (link.getAttribute('aria-label') || '').toLowerCase();
        const network = label.includes('facebook') ? 'facebook' :
            label.includes('instagram') ? 'instagram' : label.includes('tiktok') ? 'tiktok' : '';
        const url = socials[network];
        if (url && /^https:\/\//i.test(url)) {
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.hidden = false;
        } else {
            link.hidden = true;
        }
    });

    const shareLink = $id('share-whatsapp');
    if (shareLink) {
        const pageUrl = restaurantConfig.publicUrl || window.location.href;
        shareLink.href = `https://wa.me/?text=${encodeURIComponent(`${restaurantConfig.name} ${restaurantConfig.tagline || ''} ${pageUrl}`)}`;
        shareLink.target = '_blank';
        shareLink.rel = 'noopener noreferrer';
        shareLink.hidden = false;
    }

    if (restaurantConfig.mode === 'demo') {
        document.body.classList.add('demo-mode');
        const banner = document.createElement('p');
        banner.className = 'demo-mode-banner';
        banner.setAttribute('role', 'note');
        banner.textContent = 'Mode démonstration · Menu, coordonnées et événements à valider avant mise en service.';
        const header = $id('header');
        if (header) header.insertAdjacentElement('afterend', banner);
    }
};

const readStorage = key => {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : null;
    } catch (error) {
        console.warn(`Could not read browser storage key "${key}".`, error);
        return null;
    }
};

const writeStorage = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.warn('Storage unavailable', error);
    }
};

const formatPrice = amount => `${Number(amount).toLocaleString('fr-FR')} ${restaurantConfig.currency || 'FCFA'}`;

const getTableFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const pathTable = window.location.pathname.match(/\/table\/([a-zA-Z0-9_-]{1,20})\/?$/);
    const candidate = params.get('table') || (pathTable && pathTable[1]) || '';
    return /^[a-zA-Z0-9_-]{1,20}$/.test(candidate) ? candidate : restaurantConfig.defaultTableId || '';
};

const getCurrentTable = () => {
    return getTableFromUrl() || document.getElementById('order-table-id')?.value || '';
};

const getCart = () => {
    const cart = readStorage(STORAGE_KEYS.cart);
    if (!Array.isArray(cart)) return [];
    return cart.filter(item => item && typeof item.id === 'string' &&
        Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0 && Number(item.quantity) <= 20)
        .map(item => ({ id: item.id, quantity: Number(item.quantity) }));
};

const saveCart = cart => writeStorage(STORAGE_KEYS.cart, cart);

const getOrderHistory = () => readStorage(STORAGE_KEYS.orders) || [];

const saveOrderHistory = orders => writeStorage(STORAGE_KEYS.orders, orders);

const getLoyaltyPoints = () => Number(readStorage(STORAGE_KEYS.points) || 0);

const saveLoyaltyPoints = points => writeStorage(STORAGE_KEYS.points, Number(points));

const getProductById = id => productCatalog.find(item => item.id === id);
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const makeSessionId = () => {
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const getTableSession = async tableId => {
    const sessionKey = `wassa_table_session_${tableId}`;
    const storedSession = sessionStorage.getItem(sessionKey);
    if (storedSession) {
        try {
            const session = JSON.parse(storedSession);
            if (session.id && Date.parse(session.expiresAt) > Date.now()) return session.id;
        } catch (error) {
            console.warn('Discarding an outdated table session format.', error.message);
        }
        sessionStorage.removeItem(sessionKey);
    }

    const response = await apiRequest('/api/table-sessions', {
        method: 'POST',
        body: JSON.stringify({ tableId })
    });
    if (!response.data || !/^[a-f0-9]{32}$/i.test(response.data.id) || !Number.isFinite(Date.parse(response.data.expiresAt))) {
        throw new Error('Le serveur n’a pas fourni une session de table valide.');
    }
    sessionStorage.setItem(sessionKey, JSON.stringify({ id: response.data.id, expiresAt: response.data.expiresAt }));
    return response.data.id;
};

const addToCart = (productId, quantity = 1) => {
    if (!getProductById(productId) || !Number.isInteger(quantity) || quantity < 1) return;
    const cart = getCart();
    const existing = cart.find(item => item.id === productId);
    if (existing) {
        if (existing.quantity >= 20) return;
        existing.quantity = Math.min(20, existing.quantity + quantity);
    } else {
        cart.push({ id: productId, quantity: Math.min(20, quantity) });
    }
    saveCart(cart);
    renderCart();
    const toast = document.getElementById('cart-toast');
    if (toast) {
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 1200);
    }
};

const updateCartItem = (productId, qty) => {
    const cart = getCart().filter(item => item.id !== productId);
    if (qty > 0) cart.push({ id: productId, quantity: qty });
    saveCart(cart);
    renderCart();
};

const removeFromCart = productId => {
    const cart = getCart().filter(item => item.id !== productId);
    saveCart(cart);
    renderCart();
};

const getCartSummary = () => {
    const cart = getCart();
    const items = cart.map(item => {
        const product = getProductById(item.id);
        return {
            ...item,
            product,
            lineTotal: (product ? product.price : 0) * item.quantity
        };
    }).filter(item => item.product);

    const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
    return { items, total, count: items.reduce((sum, item) => sum + item.quantity, 0) };
};

const renderCart = () => {
    const cartItems = document.getElementById('cart-items');
    const cartCount = document.getElementById('cart-count');
    const cartTotal = document.getElementById('cart-total');
    const quickCartLink = document.getElementById('cart-quick-link');
    if (!cartItems && !cartCount && !cartTotal) return;

    const summary = getCartSummary();
    if (cartCount) cartCount.textContent = `${summary.count} article${summary.count > 1 ? 's' : ''}`;
    if (cartTotal) cartTotal.textContent = formatPrice(summary.total);
    if (quickCartLink) {
        quickCartLink.hidden = summary.count === 0;
        quickCartLink.textContent = `Panier · ${summary.count} · ${formatPrice(summary.total)}`;
    }

    if (!cartItems) return;
    if (!summary.items.length) {
        cartItems.innerHTML = '<p class="empty-cart">Votre panier est vide pour le moment.</p>';
        return;
    }

    cartItems.innerHTML = summary.items.map(item => `
        <div class="mini-cart-item" data-product-id="${escapeHtml(item.id)}">
            <div>
                <strong>${escapeHtml(item.product.name)}</strong>
                <small>${formatPrice(item.product.price)} x ${item.quantity}</small>
            </div>
            <div class="mini-cart-controls">
                <button type="button" aria-label="Diminuer la quantité de ${escapeHtml(item.product.name)}" data-product-action="minus" data-product-id="${escapeHtml(item.id)}">−</button>
                <span>${item.quantity}</span>
                <button type="button" aria-label="Augmenter la quantité de ${escapeHtml(item.product.name)}" data-product-action="plus" data-product-id="${escapeHtml(item.id)}">+</button>
                <button type="button" class="delete-cart-item" aria-label="Retirer ${escapeHtml(item.product.name)} du panier" data-product-action="remove" data-product-id="${escapeHtml(item.id)}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `).join('');
};

const renderMenuProducts = (selectedCategory = 'all') => {
    const grid = document.getElementById('menu-grid');
    if (!grid) return;

    const visibleProducts = productCatalog.filter(product => selectedCategory === 'all' || product.category === selectedCategory);
    grid.innerHTML = visibleProducts.map(product => `
        <article class="menu-item">
            <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">
            <div class="menu-item-content">
                <div class="menu-item-header">
                    <h3>${escapeHtml(product.name)}</h3>
                    <span class="menu-item-price">${formatPrice(product.price)}</span>
                </div>
                <div class="menu-item-tags">
                    <span class="tag">${escapeHtml(product.category)}</span>
                    <span class="tag">${escapeHtml(product.badge)}</span>
                </div>
                <p>${escapeHtml(product.description)}</p>
                <div class="menu-actions">
                    <button class="menu-item-btn" type="button" data-product-id="${escapeHtml(product.id)}">Ajouter au panier</button>
                </div>
            </div>
        </article>
    `).join('');

    const buttons = qAll('.menu-item-btn[data-product-id]');
    buttons.forEach(button => {
        button.addEventListener('click', () => {
            const productId = button.getAttribute('data-product-id');
            addToCart(productId, 1);
        });
    });
    if (!reducedMotion && 'IntersectionObserver' in window) {
        const observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.08 });
        grid.querySelectorAll('.menu-item').forEach(item => {
            item.classList.add('reveal-on-scroll');
            observer.observe(item);
        });
    }
};

const submitOrderToApi = async (payload, idempotencyKey) => {
    const response = await apiRequest('/api/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(payload)
    });
    const order = response && response.data;
    if (!order || typeof order.id !== 'string' || order.tableId !== payload.tableId ||
        !Number.isSafeInteger(order.total) || order.total <= 0 || order.status !== 'PENDING' ||
        order.paymentMethod !== 'pay_on_site' || order.paymentStatus !== 'PAY_ON_SITE') {
        throw new Error('Le serveur n’a pas confirmé la commande avec une réponse valide.');
    }
    return response.data;
};

const getOrderIdempotencyKey = (tableId, payload) => {
    const storageKey = `wassa_order_attempt_${tableId}`;
    const fingerprint = JSON.stringify(payload);
    try {
        const previous = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        if (previous && previous.fingerprint === fingerprint && /^[a-f0-9]{32}$/i.test(previous.key)) return previous.key;
        const key = makeSessionId();
        sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
        return key;
    } catch (error) {
        throw new Error('Impossible de préparer la confirmation sécurisée de la commande.');
    }
};

const placeOrder = async () => {
    const summary = getCartSummary();
    if (!summary.items.length) {
        alert('Votre panier est vide. Ajoutez au moins un produit avant de passer commande.');
        return;
    }

    const note = document.getElementById('order-note') ? document.getElementById('order-note').value.trim() : '';
    const customerName = document.getElementById('order-customer-name')?.value.trim() || '';
    const customerPhone = document.getElementById('order-customer-phone')?.value.trim() || '';
    const tableId = getCurrentTable();
    const statusMessage = document.getElementById('order-status');
    const confirmButton = document.getElementById('confirm-order-btn');
    const setOrderMessage = (text, type) => {
        if (!statusMessage) return;
        statusMessage.textContent = text;
        statusMessage.className = `order-status show${type ? ` ${type}` : ''}`;
    };
    if (!tableId) {
        setOrderMessage('Scannez le QR code de votre table ou choisissez votre table avant de commander.', 'error');
        return;
    }
    if (statusMessage) {
        setOrderMessage('Préparation de votre commande…');
    }
    if (confirmButton) confirmButton.disabled = true;

    try {
        const sessionId = await getTableSession(tableId);
        const payload = {
            tableId,
            sessionId,
            customerName: customerName || `Client table ${tableId}`,
            customerPhone,
            note,
            paymentMethod: 'pay_on_site',
            items: summary.items.map(item => ({ productId: item.id, quantity: item.quantity }))
        };
        const idempotencyKey = getOrderIdempotencyKey(tableId, payload);
        const serverOrder = await submitOrderToApi(payload, idempotencyKey);
        sessionStorage.removeItem(`wassa_order_attempt_${tableId}`);
        saveCart([]);
        renderCart();
        setOrderMessage(`Commande ${serverOrder.id} envoyée au personnel · Table ${tableId} · ${formatPrice(serverOrder.total)}. Paiement sur place, après le service.`, 'success');
        if (document.getElementById('order-note')) document.getElementById('order-note').value = '';
    } catch (error) {
        console.error('Order submission failed:', error);
        setOrderMessage(`${error.message} Votre panier a été conservé. Vous pouvez réessayer ou appeler le maquis.`, 'error');
    } finally {
        if (confirmButton) confirmButton.disabled = false;
    }
};

const bindCartInteractions = () => {
    document.addEventListener('click', event => {
        const target = event.target.closest('[data-product-action]');
        if (!target) return;
        const productId = target.getAttribute('data-product-id');
        const action = target.getAttribute('data-product-action');

        const cart = getCart();
        const item = cart.find(entry => entry.id === productId);
        if (!item) return;

        if (action === 'plus') {
            item.quantity += 1;
        }
        if (action === 'minus') {
            item.quantity -= 1;
        }
        if (action === 'remove') {
            removeFromCart(productId);
            return;
        }

        if (item.quantity <= 0) {
            removeFromCart(productId);
            return;
        }

        saveCart(cart);
        renderCart();
    });

    const confirmBtn = document.getElementById('confirm-order-btn');
    if (confirmBtn) {
        confirmBtn.addEventListener('click', placeOrder);
    }
};

const initMenuExperience = async () => {
    const grid = document.getElementById('menu-grid');
    if (!grid) return;

    const filterButtons = qAll('.filter-btn');
    filterButtons.forEach(button => {
        button.addEventListener('click', () => {
            filterButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            const category = button.getAttribute('data-category');
            renderMenuProducts(category);
        });
    });

    await loadMenuFromApi();
    const tablePicker = document.getElementById('table-order-picker');
    const tableSelect = document.getElementById('order-table-id');
    const tableContext = document.getElementById('table-order-context');
    const qrTable = getTableFromUrl();
    if (tablePicker && tableSelect) {
        if (qrTable) {
            tablePicker.hidden = true;
            if (tableContext) tableContext.textContent = `Commande pour la table ${qrTable} · paiement sur place.`;
        } else {
            tablePicker.hidden = false;
            const statusPill = document.querySelector('#table-context-card .pill');
            if (statusPill) statusPill.textContent = 'Choisir une table';
            let tableOptions = [];
            try {
                const response = await apiRequest('/api/tables', { method: 'GET' });
                tableOptions = Array.isArray(response.data) ? response.data : [];
            } catch (error) {
                if (restaurantConfig.mode !== 'demo') {
                    console.warn('Could not load available tables:', error.message);
                    if (tableContext) tableContext.textContent = 'Impossible de charger les tables. Réessayez ou contactez le maquis.';
                }
                tableOptions = (restaurantConfig.demoTables || []).map(id => ({ id, label: `Table ${id}`, status: 'available' }));
            }
            tableSelect.innerHTML = '<option value="">Choisir une table…</option>' +
                tableOptions.filter(table => table.status !== 'maintenance').map(table =>
                    `<option value="${escapeHtml(table.id)}">${escapeHtml(table.label || `Table ${table.id}`)}</option>`
                ).join('');
            if (tableContext) tableContext.textContent = 'Choisissez votre table pour transmettre la commande au bon endroit.';
            tableSelect.addEventListener('change', () => {
                const tableLabel = document.getElementById('table-label');
                const selected = tableSelect.selectedOptions[0];
                if (tableLabel) tableLabel.textContent = tableSelect.value ? (selected?.textContent || `Table ${tableSelect.value}`) : 'Table —';
                const statusPill = document.querySelector('#table-context-card .pill');
                if (statusPill) statusPill.textContent = tableSelect.value ? 'Service actif' : 'Choisir une table';
            });
        }
    }
    renderMenuProducts('all');
    renderCart();
    bindCartInteractions();

    const currentTableLabel = document.getElementById('table-label');
    if (currentTableLabel) currentTableLabel.textContent = `Table ${getCurrentTable() || '—'}`;
};

const initTableExperience = () => {
    const pageTable = document.getElementById('table-label');
    if (pageTable) {
        pageTable.textContent = `Table ${getCurrentTable() || '—'}`;
    }

};

const initHomeHighlights = () => {
    const loyalty = document.getElementById('loyalty-points');
    if (loyalty) {
        loyalty.textContent = restaurantConfig.mode === 'demo'
            ? 'Mode démo · points attribués après commande terminée'
            : 'Cumulez des points après chaque commande terminée';
    }
};

const initToast = () => {
    if (document.getElementById('cart-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'cart-toast';
    toast.className = 'cart-toast';
    toast.textContent = 'Produit ajouté au panier';
    document.body.appendChild(toast);
};

window.addEventListener('DOMContentLoaded', async () => {
    initRestaurantConfig();
    initToast();
    initHomeHighlights();
    await initMenuExperience();
    initTableExperience();
});

// --- Consolidated Loader (remplace les définitions dupliquées) ---
{
	// Création d'un petit module loader réutilisable et défensif
	const Loader = (() => {
		const ID = 'global-loader';
		const create = () => {
			if (document.getElementById(ID)) return;
			const loader = document.createElement('div');
			loader.id = ID;
			loader.className = 'global-loader';
			loader.innerHTML = '<div class="honeycomb" aria-hidden="true"><div></div><div></div><div></div><div></div><div></div><div></div><div></div></div>';
			Object.assign(loader.style, {
				position: 'fixed',
				top: '10px',
				right: '10px',
				zIndex: 99999,
				display: 'none',
				opacity: '0',
				transition: 'opacity 0.3s ease'
			});
			document.body.appendChild(loader);
		};

		const show = () => {
			create();
			const el = document.getElementById(ID);
			if (!el) return;
			el.style.display = 'block';
			// trigger transition
			requestAnimationFrame(() => { el.style.opacity = '1'; });
			el.classList.add('active');
		};

		const hide = () => {
			const el = document.getElementById(ID);
			if (!el) return;
			el.style.opacity = '0';
			el.classList.remove('active');
			setTimeout(() => { const e = document.getElementById(ID); if (e) e.style.display = 'none'; }, 300);
		};

		return { show, hide };
	})();

	// expose global helpers (compatibles avec le reste du script)
	window.showLoader = Loader.show;
	window.hideLoader = Loader.hide;
}

function safeAddListener(el, event, fn) {
    if (!el) return;
    if (NodeList.prototype.isPrototypeOf(el) || Array.isArray(el)) {
        el.forEach(item => item.addEventListener(event, fn));
    } else {
        el.addEventListener(event, fn);
    }
}

// Mobile menu
(() => {
    const menuToggle = $id('menu-toggle');
    const nav = $id('nav');

    if (!menuToggle || !nav) return;

    safeAddListener(menuToggle, 'click', () => {
        nav.classList.toggle('active');
        menuToggle.setAttribute('aria-expanded', String(nav.classList.contains('active')));
        menuToggle.innerHTML = nav.classList.contains('active') ? '<i class="fas fa-times"></i>' : '<i class="fas fa-bars"></i>';
    });

    qAll('nav ul li a').forEach(link => {
        link.addEventListener('click', () => {
            nav.classList.remove('active');
            menuToggle.setAttribute('aria-expanded', 'false');
            menuToggle.innerHTML = '<i class="fas fa-bars"></i>';
        });
    });
})();

// Header scroll effect
(() => {
    const header = $id('header');
    if (!header) return;
    safeAddListener(window, 'scroll', () => {
        if (window.scrollY > 50) header.classList.add('scrolled');
        else header.classList.remove('scrolled');
    });
})();

// Smooth scrolling for anchors
(() => {
    qAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const targetId = this.getAttribute('href');
            if (!targetId || targetId === '#') return;
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                e.preventDefault();
                window.scrollTo({ top: targetElement.offsetTop - 80, behavior: reducedMotion ? 'auto' : 'smooth' });
            }
        });
    });
})();

// Modals
(() => {
    const loginBtn = $id('login-btn');
    const loginModal = $id('login-modal');
    const signupModal = $id('signup-modal');
    const orderModal = $id('order-modal');
    const closeModals = qAll('.close-modal');
    const showSignup = $id('show-signup');
    const showLogin = $id('show-login');
    const orderBtn = $id('order-btn');
    const reserveBtn = $id('reserve-btn');

    function showModal(modal) {
        if (!modal) return;
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function hideModal(modal) {
        if (!modal) return;
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (loginBtn && loginModal) safeAddListener(loginBtn, 'click', () => showModal(loginModal));
    if (orderBtn && orderModal) safeAddListener(orderBtn, 'click', () => showModal(orderModal));

    if (reserveBtn) {
        safeAddListener(reserveBtn, 'click', () => {
            const reservation = $id('reservation');
            if (reservation) {
                window.scrollTo({ top: reservation.offsetTop - 80, behavior: reducedMotion ? 'auto' : 'smooth' });
            }
        });
    }

    closeModals.forEach(btn => {
        btn.addEventListener('click', function () {
            const modal = this.closest('.modal');
            hideModal(modal);
        });
    });

    if (showSignup) safeAddListener(showSignup, 'click', (e) => {
        e.preventDefault();
        hideModal(loginModal);
        showModal(signupModal);
    });

    if (showLogin) safeAddListener(showLogin, 'click', (e) => {
        e.preventDefault();
        hideModal(signupModal);
        showModal(loginModal);
    });

    safeAddListener(window, 'click', (e) => {
        if (e && e.target && e.target.classList && e.target.classList.contains('modal')) {
            hideModal(e.target);
        }
    });
})();

// Testimonials slider
(() => {
    const testimonialsSlider = $id('testimonials-slider');
    const prevTestimonial = $id('prev-testimonial');
    const nextTestimonial = $id('next-testimonial');
    const slides = qAll('.testimonial-card');
    if (!testimonialsSlider || slides.length === 0) return;
    let currentSlide = 0;

    function updateSlider() {
        testimonialsSlider.style.transform = `translateX(-${currentSlide * 100}%)`;
    }

    if (nextTestimonial) safeAddListener(nextTestimonial, 'click', () => {
        currentSlide = (currentSlide + 1) % slides.length;
        updateSlider();
    });

    if (prevTestimonial) safeAddListener(prevTestimonial, 'click', () => {
        currentSlide = (currentSlide - 1 + slides.length) % slides.length;
        updateSlider();
    });

    if (slides.length > 1) setInterval(() => {
        currentSlide = (currentSlide + 1) % slides.length;
        updateSlider();
    }, 5000);
})();

// Scroll to top button
(() => {
    const scrollTopBtn = $id('scroll-top');
    if (!scrollTopBtn) return;

    safeAddListener(window, 'scroll', () => {
        if (window.scrollY > 300) scrollTopBtn.classList.add('active');
        else scrollTopBtn.classList.remove('active');
    });

    const scrollTop = () => window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    safeAddListener(scrollTopBtn, 'click', scrollTop);
    safeAddListener(scrollTopBtn, 'keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            scrollTop();
        }
    });
})();

// Form submissions (safe)
(() => {
    const bookingForm = $id('booking-form');
    const bookingDate = $id('booking-date');
    if (bookingDate) bookingDate.min = new Date().toISOString().slice(0, 10);

    if (bookingForm) bookingForm.addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const status = document.getElementById('booking-status');
        const submitButton = form.querySelector('[type="submit"]');
        const date = document.getElementById('booking-date').value;
        const time = document.getElementById('booking-time').value;
        const reservation = {
            name: document.getElementById('booking-name').value.trim(),
            phone: document.getElementById('booking-phone').value.trim(),
            email: document.getElementById('booking-email').value.trim(),
            date: '',
            party: Number(document.getElementById('booking-guests').value),
            event: document.getElementById('booking-event').value,
            note: document.getElementById('booking-notes').value.trim()
        };
        const showStatus = (text, type) => {
            if (!status) return;
            status.textContent = text;
            status.className = `form-status show${type ? ` ${type}` : ''}`;
        };
        const reservationDate = new Date(`${date}T${time}`);
        if (Number.isNaN(reservationDate.getTime()) || reservationDate.getTime() <= Date.now()) {
            showStatus('Choisissez une date et une heure à venir.', 'error');
            return;
        }
        reservation.date = reservationDate.toISOString();
        if (submitButton) submitButton.disabled = true;
        showStatus('Envoi de votre demande…');
        try {
            const result = await apiRequest('/api/reservations', {
                method: 'POST',
                body: JSON.stringify(reservation)
            });
            showStatus(`Demande reçue (référence ${result.data.id}). L’équipe vous contactera pour confirmer.`, 'success');
            form.reset();
        } catch (error) {
            console.error('Reservation submission failed:', error);
            if (restaurantConfig.mode === 'demo' && error instanceof TypeError) {
                const demoRequests = readStorage('wassa_demo_reservations') || [];
                demoRequests.unshift({ ...reservation, mode: 'demo_local_only' });
                writeStorage('wassa_demo_reservations', demoRequests);
                showStatus('Démo locale uniquement : la demande n’a pas été transmise au restaurant.', 'notice');
                form.reset();
            } else {
                showStatus(`${error.message} Votre demande n’a pas été transmise. Réessayez ou contactez le maquis.`, 'error');
            }
        } finally {
            if (submitButton) submitButton.disabled = false;
        }
    });

})();

// Reveal fixed page cards as they approach the viewport; menu cards are handled after filtering.
(() => {
    if (reducedMotion || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.08 });
    qAll('.service-card, .team-member, .event-card, .Tonight-card, .overview .card').forEach(element => {
        element.classList.add('reveal-on-scroll');
        observer.observe(element);
    });
})();