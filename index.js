// ==================== FIREBASE CONFIGURATION ====================
const firebaseConfig = {
    apiKey: "AIzaSyAcHjmqm1xLGdMGr85LJOuN-ar_FEf3OxA",
    authDomain: "smmapp-5ca85.firebaseapp.com",
    projectId: "smmapp-5ca85",
    storageBucket: "smmapp-5ca85.firebasestorage.app",
    messagingSenderId: "926421685215",
    appId: "1:926421685215:web:df59434467b89798b2ea6a",
    measurementId: "G-6N4QEE6GSE"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

// ==================== CACHE HELPERS ====================
const CACHE_KEY_PRODUCTS = 'abm10_products_cache';
const CACHE_KEY_PAYMENTS = 'abm10_payments_cache';
const CACHE_DURATION = 5 * 60 * 1000;

function getCache(key) {
    try {
        const item = localStorage.getItem(key);
        if (!item) return null;
        const parsed = JSON.parse(item);
        if (Date.now() - parsed.timestamp > CACHE_DURATION) return null;
        return parsed.data;
    } catch { return null; }
}
function setCache(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() })); } catch {}
}

// ==================== THEME ====================
function initTheme() {
    const saved = localStorage.getItem('abm10_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeToggleIcon();
}
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('abm10_theme', next);
    updateThemeToggleIcon();
}
function updateThemeToggleIcon() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    btn.innerHTML = isLight ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
}
initTheme();

// ==================== GLOBAL STATE ====================
let currentUser = null;
let isAdmin = false;
let currentView = 'home';
let adminSubView = 'overview';
let userDashTab = 'orders';
let selectedProduct = null;
let allProducts = [];
let allPaymentMethods = [];
let notificationCount = 0;
let unsubscribeAdminOrders = null;
let unsubscribeUserNotifs = null;
let appliedCoupon = null;
let orderTotalBeforeCoupon = 0;
let botSettings = null;

// ==================== CATEGORY ICON MAPPER (fixed) ====================
function getCategoryIcon(category) {
    if (!category) return 'fa-star';
    const lower = category.toLowerCase();
    // Check for partial matches to cover all possible admin inputs
    if (lower.includes('telegram')) return 'fa-paper-plane';
    if (lower.includes('tiktok')) return 'fa-music';
    if (lower.includes('instagram')) return 'fa-instagram';
    if (lower.includes('youtube')) return 'fa-youtube';
    if (lower.includes('pubg')) return 'fa-gamepad';
    if (lower.includes('free fire') || lower.includes('diamond')) return 'fa-gem';
    if (lower.includes('account') || lower.includes('channel')) return 'fa-store';
    if (lower.includes('other') || lower.includes('digital')) return 'fa-globe';
    return 'fa-star';
}

// ==================== TELEGRAM BOT NOTIFICATION ====================
async function loadBotSettings() {
    try {
        const doc = await db.collection('settings').doc('bot').get();
        botSettings = doc.exists ? doc.data() : null;
    } catch { botSettings = null; }
}
async function sendTelegramNotification(message) {
    if (!botSettings?.token || !botSettings?.userId) return;
    try {
        await fetch(`https://api.telegram.org/bot${botSettings.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: botSettings.userId,
                text: message,
                parse_mode: 'HTML'
            })
        });
    } catch { /* silent fail */ }
}

// ==================== AUTH STATE LISTENER ====================
auth.onAuthStateChanged(async (user) => {
    currentUser = user;
    if (user) {
        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                isAdmin = userData.role === 'admin';
                if (userData.status === 'banned') {
                    isAdmin = false;
                    await auth.signOut();
                    showToast('Your account has been banned.', 'error');
                    return;
                }
            } else {
                await db.collection('users').doc(user.uid).set({
                    email: user.email,
                    role: 'user',
                    status: 'active',
                    createdAt: Date.now(),
                });
                isAdmin = false;
            }
        } catch (err) {
            isAdmin = false;
        }
        if (isAdmin) await loadBotSettings();
        setupRealTimeListeners();
    } else {
        isAdmin = false;
        notificationCount = 0;
        if (unsubscribeAdminOrders) { unsubscribeAdminOrders(); unsubscribeAdminOrders = null; }
        if (unsubscribeUserNotifs) { unsubscribeUserNotifs(); unsubscribeUserNotifs = null; }
    }
    updateNavUI();
    render();
});

function setupRealTimeListeners() {
    if (unsubscribeAdminOrders) unsubscribeAdminOrders();
    if (unsubscribeUserNotifs) unsubscribeUserNotifs();
    if (isAdmin) {
        unsubscribeAdminOrders = db.collection('orders').where('status', '==', 'pending').onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                if (change.type === 'added') {
                    const order = { id: change.doc.id, ...change.doc.data() };
                    notificationCount = snap.size;
                    updateNavUI();
                    showToast(`New order from ${order.userEmail}`, 'info');
                    // 🔔 Send Telegram notification from admin side
                    const pmName = allPaymentMethods.find(m => m.id === order.paymentMethodId)?.name || 'Unknown';
                    const tgMsg = `🔔 <b>New Order</b>\n\n👤 ${order.userEmail}\n📦 ${order.productName}${order.packageName ? ` (${order.packageName})` : ''}\n👤 Account: ${order.customerAccount || 'N/A'}\n🔢 Qty: ${order.quantity}\n💳 Method: ${pmName}\n💰 Br ${order.totalPrice?.toFixed(2)}\n📅 ${new Date(order.createdAt).toLocaleString()}`;
                    sendTelegramNotification(tgMsg);
                    // Refresh admin views
                    if (currentView === 'admin') {
                        if (adminSubView === 'overview') loadAdminOverview();
                        if (adminSubView === 'orders') loadAdminOrders();
                    }
                }
            });
        });
        db.collection('notifications').where('targetId', '==', 'admin').where('read', '==', false).onSnapshot(snap => {
            notificationCount = snap.size;
            updateNavUI();
        });
    }
    if (currentUser && !isAdmin) {
        unsubscribeUserNotifs = db.collection('notifications').where('targetId', '==', currentUser.uid).where('read', '==', false).onSnapshot(snap => {
            notificationCount = snap.size;
            updateNavUI();
        });
    }
}

// ==================== NAVIGATION ====================
function navigate(view, data = null) {
    if (view === 'admin' && !isAdmin) { showToast('Access denied.', 'error'); return; }
    if (view === 'dashboard' && !currentUser) { showToast('Please log in first.', 'info'); view = 'login'; }
    currentView = view;
    if (view === 'admin') adminSubView = 'overview';
    if (view === 'dashboard') userDashTab = 'orders';
    if (data) selectedProduct = data;
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.remove('open');
    render();
    window.scrollTo(0, 0);
}
function setAdminSubView(s) { adminSubView = s; render(); }
function setUserDashTab(t) { userDashTab = t; render(); }
function toggleSidebar() { document.querySelector('.sidebar')?.classList.toggle('open'); }

function updateNavUI() {
    const navLinks = document.getElementById('navLinks');
    const mobileNav = document.getElementById('mobileBottomNav');
    if (currentUser) {
        navLinks.innerHTML = `
            <li><a onclick="navigate('home')"><i class="fas fa-home"></i> Home</a></li>
            <li><a onclick="navigate('products')"><i class="fas fa-th-large"></i> Services</a></li>
            <li><a onclick="navigate('dashboard')" class="notif-badge"><i class="fas fa-tachometer-alt"></i> Dashboard${notificationCount>0?`<span class="count">${notificationCount}</span>`:''}</a></li>
            ${isAdmin?`<li><a onclick="navigate('admin')" class="notif-badge"><i class="fas fa-shield-alt"></i> Admin${notificationCount>0?`<span class="count">${notificationCount}</span>`:''}</a></li>`:''}
            <li><a onclick="logout()" class="btn-outline btn-sm"><i class="fas fa-sign-out-alt"></i> Logout</a></li>
        `;
        mobileNav.innerHTML = `
            <a onclick="navigate('home')"><i class="fas fa-home"></i> Home</a>
            <a onclick="navigate('products')"><i class="fas fa-th-large"></i> Services</a>
            <a onclick="navigate('dashboard')"><i class="fas fa-tachometer-alt"></i> Dashboard</a>
            ${isAdmin?`<a onclick="navigate('admin')"><i class="fas fa-shield-alt"></i> Admin</a>`:''}
            <a onclick="logout()"><i class="fas fa-sign-out-alt"></i> Logout</a>
        `;
    } else {
        navLinks.innerHTML = `
            <li><a onclick="navigate('home')"><i class="fas fa-home"></i> Home</a></li>
            <li><a onclick="navigate('products')"><i class="fas fa-th-large"></i> Services</a></li>
            <li><a onclick="navigate('login')"><i class="fas fa-sign-in-alt"></i> Login</a></li>
            <li><a onclick="navigate('register')" class="btn-primary btn-sm"><i class="fas fa-user-plus"></i> Register</a></li>
        `;
        mobileNav.innerHTML = `
            <a onclick="navigate('home')"><i class="fas fa-home"></i> Home</a>
            <a onclick="navigate('products')"><i class="fas fa-th-large"></i> Services</a>
            <a onclick="navigate('login')"><i class="fas fa-sign-in-alt"></i> Login</a>
            <a onclick="navigate('register')"><i class="fas fa-user-plus"></i> Register</a>
        `;
    }
    updateThemeToggleIcon();
}

async function logout() {
    await auth.signOut();
    currentUser = null; isAdmin = false; notificationCount = 0;
    navigate('home');
    showToast('Logged out successfully', 'info');
}

function render() {
    const app = document.getElementById('app');
    if (!app) return;
    switch (currentView) {
        case 'home': renderHome(app); break;
        case 'login': renderAuthPage(app, 'login'); break;
        case 'register': renderAuthPage(app, 'register'); break;
        case 'products': renderProductsPage(app); break;
        case 'product-detail': renderProductDetailPage(app); break;
        case 'dashboard': if (!currentUser) { navigate('login'); return; } renderUserDashboard(app); break;
        case 'admin': if (!isAdmin) { navigate('home'); return; } renderAdminDashboard(app); break;
        default: renderHome(app);
    }
}

// ==================== HOME PAGE ====================
function renderHome(app) {
    app.innerHTML = `
        <section class="hero">
            <h1>Grow Your <span class="gradient-text">Social Presence</span><br>Instantly with ABM-10 TOPUP</h1>
            <p>Boost your social media accounts with real followers, likes, views, and more. Fast delivery, competitive prices, 24/7 support.</p>
            <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
                <button class="btn btn-primary btn-lg" onclick="navigate('products')"><i class="fas fa-bolt"></i> View All Services</button>
                <button class="btn btn-outline btn-lg" onclick="navigate('register')"><i class="fas fa-user-plus"></i> Get Started Free</button>
            </div>
            <div class="stats-grid">
                <div class="stat-card"><div class="stat-number">50K+</div><div class="stat-label">Happy Customers</div></div>
                <div class="stat-card"><div class="stat-number">1M+</div><div class="stat-label">Orders Completed</div></div>
                <div class="stat-card"><div class="stat-number">99.9%</div><div class="stat-label">Uptime Guarantee</div></div>
                <div class="stat-card"><div class="stat-number">24/7</div><div class="stat-label">Live Support</div></div>
            </div>
        </section>
        <section class="section">
            <h2 class="section-title">Service Categories</h2>
            <div class="category-grid">
                ${['Telegram','TikTok','Instagram','YouTube','PUBG UC','Free Fire','Accounts','More'].map(cat => `
                    <div class="category-item" onclick="navigate('products')">
                        <i class="fas ${getCategoryIcon(cat)}"></i>
                        <div style="font-weight:600;font-size:0.9rem;margin-top:0.5rem;">${cat}</div>
                    </div>
                `).join('')}
            </div>
        </section>
        <section class="section">
            <h2 class="section-title">Popular Services</h2>
            <div class="product-grid" id="homePopularProducts">${Array(4).fill(`<div class="product-card glass-card-static"><div class="product-img-wrapper"><div class="skeleton" style="width:100%;height:100%;"></div></div><div class="product-info"><div class="skeleton" style="width:70%;height:20px;"></div><div class="skeleton" style="width:40%;height:16px;"></div><div class="skeleton" style="width:30%;height:24px;"></div></div></div>`).join('')}</div>
        </section>
        <footer style="background:var(--bg-secondary);border-top:1px solid var(--border);padding:2rem;text-align:center;">
            <div class="dev-credit">
                <img src="dev.png" alt="Nexora" onerror="this.style.display='none'">
                <span>Powered by <a href="https://t.me/nexora_creatives" target="_blank">Nexora</a> — @nexora_creatives</span>
            </div>
            <p style="color:var(--text-muted);font-size:0.8rem;">© 2026 ABM-10 TOPUP. All rights reserved. | <a href="https://t.me/abm10topup" target="_blank" style="color:var(--gold-light);">@abm10topup</a></p>
        </footer>
    `;
    loadPopularProducts();
}

async function loadPopularProducts() {
    const container = document.getElementById('homePopularProducts');
    if (!container) return;
    let products = getCache(CACHE_KEY_PRODUCTS);
    if (!products) {
        const snap = await db.collection('products').where('status', '==', 'active').limit(4).get();
        products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setCache(CACHE_KEY_PRODUCTS, products);
    }
    if (!products.length) {
        container.innerHTML = '<p style="text-align:center;grid-column:1/-1;color:var(--text-muted);">No products available yet.</p>';
        return;
    }
    container.innerHTML = products.slice(0, 4).map(p => {
        const priceDisplay = p.orderType==='fixed'&&p.amounts?.length?`From Br ${Math.min(...p.amounts.map(a=>a.price)).toFixed(2)}`:(p.price?`Br ${p.price.toFixed(2)}/per`:'');
        return `<div class="product-card" onclick="selectedProduct=${JSON.stringify(p).replace(/"/g,'&quot;')};navigate('product-detail')"><div class="product-img-wrapper">${p.imageUrl?`<img src="${p.imageUrl}" alt="${p.name}" loading="lazy">`:`<i class="fas ${getCategoryIcon(p.category)} product-img-icon"></i>`}</div><div class="product-info"><h4>${p.name}</h4><p style="color:var(--text-muted);font-size:0.8rem;">${p.category}</p><div class="product-price">${priceDisplay}</div><span class="badge badge-active">Active</span></div></div>`;
    }).join('');
}

// ==================== AUTH PAGES (unchanged) ====================
function renderAuthPage(app, type) {
    const isLogin = type === 'login';
    app.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:80px 1rem 2rem;"><div class="glass-card-static" style="max-width:440px;width:100%;padding:2.5rem;"><div style="text-align:center;margin-bottom:1.5rem;"><i class="fas ${isLogin?'fa-sign-in-alt':'fa-user-plus'} fa-2x" style="color:var(--gold-light);"></i><h2 style="margin-top:0.5rem;">${isLogin?'Welcome Back':'Create Account'}</h2><p style="color:var(--text-muted);font-size:0.85rem;">${isLogin?'Sign in to your account':'Join ABM-10 TOPUP today'}</p></div><form id="authForm" onsubmit="handleAuth(event,'${type}')"><div class="form-group"><label><i class="fas fa-envelope"></i> Email</label><input type="email" id="authEmail" required placeholder="your@email.com" autocomplete="email"></div><div class="form-group"><label><i class="fas fa-lock"></i> Password</label><input type="password" id="authPassword" required placeholder="••••••••" minlength="6"></div>${!isLogin?`<div class="form-group"><label><i class="fas fa-lock"></i> Confirm Password</label><input type="password" id="authConfirmPassword" required placeholder="••••••••" minlength="6"></div>`:''}<button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;"><i class="fas ${isLogin?'fa-sign-in-alt':'fa-user-plus'}"></i> ${isLogin?'Sign In':'Create Account'}</button></form><div style="text-align:center;margin:1rem 0;color:var(--text-muted);">— or —</div><button class="btn btn-outline" style="width:100%;justify-content:center;" onclick="handleGoogleLogin()"><i class="fab fa-google"></i> Continue with Google</button><p style="text-align:center;margin-top:1.2rem;font-size:0.85rem;">${isLogin?`Don't have an account? <a onclick="navigate('register')" style="color:var(--gold-light);cursor:pointer;">Register here</a>`:`Already have an account? <a onclick="navigate('login')" style="color:var(--gold-light);cursor:pointer;">Sign in</a>`}</p>${isLogin?`<p style="text-align:center;margin-top:0.5rem;"><a onclick="handleForgotPassword()" style="color:var(--text-muted);font-size:0.8rem;cursor:pointer;">Forgot password?</a></p>`:''}</div></div>`;
}
async function handleAuth(e, type) {
    e.preventDefault();
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!email||!password) return showToast('Please fill in all fields.','error');
    if (password.length<6) return showToast('Password must be at least 6 characters.','error');
    if (type==='register') {
        if (password!==document.getElementById('authConfirmPassword').value) return showToast('Passwords do not match.','error');
        try {
            const result = await auth.createUserWithEmailAndPassword(email,password);
            await db.collection('users').doc(result.user.uid).set({email,role:'user',status:'active',createdAt:Date.now()});
            showToast('Account created!','success');
            navigate('dashboard');
        } catch(err) { showToast(getFirebaseErrorMessage(err.code),'error'); }
    } else {
        try { await auth.signInWithEmailAndPassword(email,password); showToast('Logged in!','success'); navigate('dashboard'); }
        catch(err) { showToast(getFirebaseErrorMessage(err.code),'error'); }
    }
}
async function handleGoogleLogin() {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
        const result = await auth.signInWithPopup(provider);
        const doc = await db.collection('users').doc(result.user.uid).get();
        if(!doc.exists) await db.collection('users').doc(result.user.uid).set({email:result.user.email,role:'user',status:'active',createdAt:Date.now()});
        showToast('Logged in with Google!','success');
        navigate('dashboard');
    } catch(err) { showToast(getFirebaseErrorMessage(err.code),'error'); }
}
async function handleForgotPassword() {
    const email = prompt('Enter your email address to reset password:');
    if(!email) return;
    try { await auth.sendPasswordResetEmail(email); showToast('Password reset email sent!','success'); }
    catch(err) { showToast(getFirebaseErrorMessage(err.code),'error'); }
}
function getFirebaseErrorMessage(code) {
    const m={'auth/email-already-in-use':'This email is already registered.','auth/invalid-email':'Invalid email address.','auth/user-not-found':'No account found with this email.','auth/wrong-password':'Incorrect password.','auth/weak-password':'Password is too weak. Use at least 6 characters.','auth/too-many-requests':'Too many attempts. Please try again later.','auth/popup-closed-by-user':'Login popup was closed.','auth/network-request-failed':'Network error. Please check your connection.'};
    return m[code]||'An error occurred. Please try again.';
}

// ==================== PRODUCTS PAGE ====================
function renderProductsPage(app) {
    app.innerHTML = `<div style="padding:80px 2rem 2rem;max-width:1200px;margin:0 auto;"><h2 class="section-title"><i class="fas fa-th-large"></i> All Services</h2><div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:1.5rem;"><div style="flex:1;min-width:200px;position:relative;"><i class="fas fa-search" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-muted);"></i><input type="text" id="productSearch" placeholder="Search services..." style="padding-left:40px;" oninput="filterProducts()"></div><select id="categoryFilter" onchange="filterProducts()" style="max-width:200px;"><option value="">All Categories</option><option>Telegram Services</option><option>TikTok Services</option><option>Instagram Services</option><option>YouTube Services</option><option>PUBG UC</option><option>Free Fire Diamonds</option><option>Other Digital Services</option><option>Accounts/Channels</option></select><select id="sortFilter" onchange="filterProducts()" style="max-width:160px;"><option value="default">Default</option><option value="price-asc">Price: Low → High</option><option value="price-desc">Price: High → Low</option></select></div><div class="product-grid" id="allProductsGrid">${Array(6).fill(`<div class="product-card glass-card-static"><div class="product-img-wrapper"><div class="skeleton" style="width:100%;height:100%;"></div></div><div class="product-info"><div class="skeleton" style="width:70%;height:20px;"></div><div class="skeleton" style="width:40%;height:16px;"></div><div class="skeleton" style="width:30%;height:24px;"></div></div></div>`).join('')}</div><p id="noProductsFound" style="text-align:center;color:var(--text-muted);display:none;">No products found.</p></div>`;
    loadAllProducts();
}
async function loadAllProducts() {
    let cached = getCache(CACHE_KEY_PRODUCTS);
    if (cached) { allProducts = cached; filterProducts(); }
    const snap = await db.collection('products').where('status','==','active').get();
    allProducts = snap.docs.map(d=>({id:d.id,...d.data()}));
    setCache(CACHE_KEY_PRODUCTS, allProducts);
    filterProducts();
}
function filterProducts() {
    const grid = document.getElementById('allProductsGrid');
    const noResults = document.getElementById('noProductsFound');
    if(!grid) return;
    const search = (document.getElementById('productSearch')?.value||'').toLowerCase().trim();
    const category = document.getElementById('categoryFilter')?.value||'';
    const sort = document.getElementById('sortFilter')?.value||'default';
    let filtered = [...allProducts];
    if(search) filtered = filtered.filter(p=>p.name.toLowerCase().includes(search)||p.category.toLowerCase().includes(search));
    if(category) filtered = filtered.filter(p=>p.category===category);
    if(sort==='price-asc') filtered.sort((a,b)=>(a.price||0)-(b.price||0));
    else if(sort==='price-desc') filtered.sort((a,b)=>(b.price||0)-(a.price||0));
    if(!filtered.length) { grid.innerHTML=''; noResults.style.display='block'; }
    else {
        noResults.style.display='none';
        grid.innerHTML = filtered.map(p=>{
            const priceDisplay = p.orderType==='fixed'&&p.amounts?.length?`From Br ${Math.min(...p.amounts.map(a=>a.price)).toFixed(2)}`:(p.price?`Br ${p.price.toFixed(2)}/per`:'');
            return `<div class="product-card" onclick="selectedProduct=${JSON.stringify(p).replace(/"/g,'&quot;')};navigate('product-detail')"><div class="product-img-wrapper">${p.imageUrl?`<img src="${p.imageUrl}" alt="${p.name}" loading="lazy">`:`<i class="fas ${getCategoryIcon(p.category)} product-img-icon"></i>`}</div><div class="product-info"><h4>${p.name}</h4><p style="color:var(--text-muted);font-size:0.8rem;">${p.category}</p><div class="product-price">${priceDisplay}</div><span class="badge badge-active">Active</span></div></div>`;
        }).join('');
    }
}

// ==================== PRODUCT DETAIL & ORDER ====================
function renderProductDetailPage(app) {
    if(!selectedProduct){navigate('products');return;}
    const p = selectedProduct;
    const packages = p.amounts||p.packages||[];
    orderTotalBeforeCoupon = packages.length?packages[0].price:((p.price||0)*(p.minQty||100));
    appliedCoupon = null;
    app.innerHTML = `<div style="padding:80px 2rem 2rem;max-width:700px;margin:0 auto;"><button class="btn btn-outline btn-sm" onclick="navigate('products')"><i class="fas fa-arrow-left"></i> Back</button><div class="glass-card-static" style="padding:2rem;margin-top:1rem;"><div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">${p.imageUrl?`<img src="${p.imageUrl}" style="width:80px;height:80px;object-fit:cover;border-radius:12px;">`:`<div style="width:80px;height:80px;border-radius:12px;background:var(--gold-gradient);display:flex;align-items:center;justify-content:center;"><i class="fas ${getCategoryIcon(p.category)} fa-2x" style="color:#000;"></i></div>`}<div><h2>${p.name}</h2><p style="color:var(--text-muted);">${p.category} | ${p.deliveryTime||'1-24h'}</p></div></div>${p.description?`<p style="margin-top:1rem;color:var(--text-secondary);">${p.description}</p>`:''}<div id="orderForm" style="border-top:1px solid var(--border);padding-top:1.5rem;"><h4><i class="fas fa-shopping-cart"></i> Place Your Order</h4>${packages.length?`<div class="form-group"><label>Select Package</label><select id="packageSelect" onchange="updateOrderTotal()">${packages.map(pk=>`<option value="${pk.price}" data-name="${pk.name}" data-note="${pk.note||''}">${pk.name} — Br ${pk.price.toFixed(2)}</option>`).join('')}</select><small id="packageNote" style="color:var(--orange);display:block;margin-top:4px;"></small></div>`:`<div class="form-group"><label>Quantity (${p.minQty||10} — ${p.maxQty||100000})</label><input type="number" id="quantityInput" min="${p.minQty||10}" max="${p.maxQty||100000}" value="${p.minQty||100}" oninput="updateOrderTotal()"></div>`}<div style="font-size:2rem;font-weight:700;color:var(--gold-light);text-align:center;">Total: Br <span id="orderTotal">${orderTotalBeforeCoupon.toFixed(2)}</span></div>
    <div class="form-group"><label><i class="fas fa-user"></i> Your Account / ID</label><input type="text" id="customerAccount" placeholder="e.g. @username, PUBG ID, video URL" required><small style="color:var(--orange);">This is where we'll deliver your service. Make sure it's correct!</small></div>
    <div class="form-group"><label>Coupon Code (Optional)</label><div style="display:flex;gap:8px;"><input type="text" id="couponCodeInput" placeholder="Enter code"><button class="btn btn-outline btn-sm" onclick="applyCoupon()">Apply</button></div><small id="couponStatus" style="color:var(--green);display:none;"></small></div>
    <div class="form-group"><label>Payment Method</label><div id="paymentMethodsList">Loading...</div></div>
    <div class="form-group"><label>Upload Payment Screenshot</label><div class="file-upload-wrapper"><input type="file" id="paymentScreenshot" accept="image/*" onchange="previewScreenshot(this)"><div class="file-upload-label"><i class="fas fa-cloud-upload-alt"></i> Choose Image</div></div><img id="screenshotPreview" style="max-width:200px;margin-top:10px;border-radius:8px;display:none;"></div>
    <button class="btn btn-primary btn-lg" style="width:100%;" onclick="submitOrder()" id="submitOrderBtn" ${currentUser?'':'disabled'}><i class="fas fa-paper-plane"></i> Place Order</button>
    ${!currentUser?'<p style="text-align:center;margin-top:12px;color:var(--text-muted);">Please <a onclick="navigate(\'login\')" style="color:var(--gold-light);cursor:pointer;">log in</a> to place an order.</p>':''}
    <p style="text-align:center;font-size:0.85rem;color:var(--text-muted);margin-top:10px;"><i class="fab fa-telegram"></i> Need help? Contact admin: <a href="https://t.me/ihaveonequestion1" target="_blank" style="color:var(--gold-light);">@ihaveonequestion1</a></p>
    </div></div></div>`;
    if(packages.length){
        const sel = document.getElementById('packageSelect');
        const updateNote = ()=>{ const opt=sel.selectedOptions[0]; document.getElementById('packageNote').textContent=opt?.dataset?.note||''; };
        sel.addEventListener('change',updateNote);
        updateNote();
    }
    loadPaymentMethodsForOrder();
}
function updateOrderTotal() {
    const p=selectedProduct;
    if(!p)return;
    const packages=p.amounts||p.packages||[];
    let total=packages.length?parseFloat(document.getElementById('packageSelect')?.value||packages[0].price):(p.price||0)*(parseInt(document.getElementById('quantityInput')?.value||p.minQty||100));
    orderTotalBeforeCoupon=total;
    appliedCoupon=null;
    document.getElementById('couponStatus').style.display='none';
    document.getElementById('orderTotal').textContent=total.toFixed(2);
}
async function loadPaymentMethodsForOrder() {
    const container=document.getElementById('paymentMethodsList');
    if(!container)return;
    let cached=getCache(CACHE_KEY_PAYMENTS);
    if(cached){allPaymentMethods=cached;renderPaymentMethodsList(container);}
    const snap=await db.collection('paymentMethods').get();
    allPaymentMethods=snap.docs.map(d=>({id:d.id,...d.data()}));
    setCache(CACHE_KEY_PAYMENTS,allPaymentMethods);
    renderPaymentMethodsList(container);
}
function renderPaymentMethodsList(container) {
    if(!allPaymentMethods.length){container.innerHTML='<p style="color:var(--text-muted);">No payment methods available.</p>';return;}
    container.innerHTML=allPaymentMethods.map((m,i)=>`<div class="payment-method-item" style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;cursor:pointer;" onclick="selectPaymentMethod(this,'${m.id}')"><input type="radio" name="paymentMethod" value="${m.id}" ${i===0?'checked':''} style="width:auto;"><div style="flex:1;"><strong>${m.name}</strong><p style="color:var(--text-muted);font-size:0.8rem;">Account: ${m.accountNumber}</p></div><i class="fas fa-copy copy-btn" onclick="event.stopPropagation();copyToClipboard('${m.accountNumber}')"></i></div>`).join('');
}
function selectPaymentMethod(el){el.querySelector('input').checked=true;document.querySelectorAll('.payment-method-item').forEach(e=>e.style.borderColor='var(--border)');el.style.borderColor='var(--gold-primary)';}
function previewScreenshot(input){
    const preview=document.getElementById('screenshotPreview');
    if(input.files&&input.files[0]){
        if(input.files[0].size > 5 * 1024 * 1024){
            showToast('File size must be less than 5MB.','error');
            input.value='';
            preview.style.display='none';
            return;
        }
        const validTypes = ['image/jpeg','image/png','image/gif','image/webp'];
        if(!validTypes.includes(input.files[0].type)){
            showToast('Please upload a valid image (JPG, PNG, GIF, WEBP).','error');
            input.value='';
            preview.style.display='none';
            return;
        }
        const reader=new FileReader();
        reader.onload=e=>{preview.src=e.target.result;preview.style.display='block';};
        reader.readAsDataURL(input.files[0]);
    }
}
async function compressImage(file, maxSizeKB = 400) {
    if (!file.type.startsWith('image/') || file.size <= maxSizeKB * 1024) return file;
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement('canvas');
            let width = img.width, height = img.height;
            if (width > 800) { height = Math.round((800/width)*height); width = 800; }
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            canvas.toBlob(blob => {
                if (!blob) return reject(new Error('Compression failed'));
                if (blob.size > maxSizeKB * 1024) {
                    canvas.toBlob(blob2 => {
                        if (!blob2) reject(new Error('Compression failed'));
                        else resolve(new File([blob2], file.name, { type: 'image/jpeg' }));
                    }, 'image/jpeg', 0.5);
                } else {
                    resolve(new File([blob], file.name, { type: 'image/jpeg' }));
                }
            }, 'image/jpeg', 0.7);
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = url;
    });
}
async function applyCoupon(){
    const code=document.getElementById('couponCodeInput')?.value.trim().toUpperCase();
    const statusEl=document.getElementById('couponStatus');
    if(!code){showToast('Please enter a coupon code.','error');return;}
    const snap=await db.collection('coupons').where('code','==',code).limit(1).get();
    if(snap.empty){showToast('Invalid coupon code.','error');return;}
    const coupon={id:snap.docs[0].id,...snap.docs[0].data()};
    if(coupon.maxUsage>0&&(coupon.used||0)>=coupon.maxUsage){showToast('Coupon usage limit reached.','error');return;}
    if(coupon.expiresAt&&Date.now()>coupon.expiresAt){showToast('Coupon has expired.','error');return;}
    const discount=coupon.discount/100;
    const newTotal=(orderTotalBeforeCoupon*(1-discount)).toFixed(2);
    document.getElementById('orderTotal').textContent=newTotal;
    statusEl.textContent=`Coupon applied! ${coupon.discount}% off (-Br ${(orderTotalBeforeCoupon*discount).toFixed(2)})`;
    statusEl.style.display='block';statusEl.style.color='var(--green)';
    appliedCoupon=coupon;
    showToast(`Coupon applied: ${coupon.discount}% discount!`,'success');
}

async function submitOrder(){
    if(!currentUser){showToast('Please log in first.','error');navigate('login');return;}
    const p=selectedProduct; if(!p)return;
    const customerAccount = document.getElementById('customerAccount')?.value.trim();
    if(!customerAccount){showToast('Please enter your account/ID.','error');return;}
    const fileInput=document.getElementById('paymentScreenshot');
    const file=fileInput?.files[0];
    if(!file){showToast('Please upload a payment screenshot.','error');return;}
    const pmId=document.querySelector('input[name="paymentMethod"]:checked')?.value;
    if(!pmId){showToast('Please select a payment method.','error');return;}
    let quantity, totalPrice, packageName=null;
    const packages=p.amounts||p.packages||[];
    if(packages.length){const sel=document.getElementById('packageSelect');packageName=sel?.options[sel.selectedIndex]?.dataset?.name||packages[0].name;totalPrice=parseFloat(document.getElementById('orderTotal').textContent);quantity=1;}
    else{quantity=parseInt(document.getElementById('quantityInput')?.value||p.minQty||100);totalPrice=parseFloat(document.getElementById('orderTotal').textContent);}
    const btn=document.getElementById('submitOrderBtn');
    const origText=btn.innerHTML;
    btn.disabled=true;
    btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Optimizing image…';
    const timeoutId = setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = origText;
        showToast('Request timed out. Please try again.','error');
    }, 45000);
    try {
        const compressedFile = await compressImage(file, 400);
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => { showToast('Failed to read the image. Try a smaller file.','error'); reject(new Error('FileReader error')); };
            reader.readAsDataURL(compressedFile);
        });
        clearTimeout(timeoutId);
        const orderData={
            userId:currentUser.uid,
            userEmail:currentUser.email,
            productId:p.id,
            productName:p.name,
            category:p.category,
            quantity,
            totalPrice,
            originalPrice:orderTotalBeforeCoupon,
            packageName,
            paymentMethodId:pmId,
            screenshotUrl:base64,
            customerAccount,
            couponApplied:appliedCoupon?{code:appliedCoupon.code,discount:appliedCoupon.discount}:null,
            status:'pending',
            createdAt:Date.now(),
            updatedAt:Date.now()
        };
        await db.collection('orders').add(orderData);
        if(appliedCoupon) await db.collection('coupons').doc(appliedCoupon.id).update({used:firebase.firestore.FieldValue.increment(1)});
        await db.collection('notifications').add({targetId:'admin',title:'New Order Received',message:`${currentUser.email} placed an order for ${p.name} — Br ${totalPrice.toFixed(2)}`,read:false,createdAt:Date.now()});
        // Telegram notification is now handled by admin listener (no need here)
        showToast('Order placed successfully!','success');
        navigate('dashboard');
    } catch(err){
        clearTimeout(timeoutId);
        console.error('Order failed:', err);
        showToast('Error placing order: ' + (err.message || 'Unknown error'), 'error');
        btn.disabled = false;
        btn.innerHTML = origText;
    }
}

// ==================== USER DASHBOARD ====================
function renderUserDashboard(app){
    app.innerHTML=`<div class="dashboard-layout"><div class="sidebar" id="userSidebar"><div style="text-align:center;padding:1rem 0;border-bottom:1px solid var(--border);margin-bottom:1rem;"><i class="fas fa-user-circle fa-3x" style="color:var(--gold-light);"></i><p style="margin-top:0.5rem;font-weight:600;">${currentUser?.email||'User'}</p><span class="badge badge-info">${isAdmin?'Admin':'Customer'}</span></div><ul class="sidebar-nav"><li><a class="${userDashTab==='orders'?'active':''}" onclick="setUserDashTab('orders')"><i class="fas fa-shopping-cart"></i> My Orders</a></li><li><a class="${userDashTab==='notifications'?'active':''}" onclick="setUserDashTab('notifications')"><i class="fas fa-bell"></i> Notifications ${notificationCount>0?`<span class="badge badge-pending" style="margin-left:auto;">${notificationCount}</span>`:''}</a></li><li><a class="${userDashTab==='settings'?'active':''}" onclick="setUserDashTab('settings')"><i class="fas fa-cog"></i> Settings</a></li><li><a onclick="logout()"><i class="fas fa-sign-out-alt"></i> Logout</a></li></ul></div><div class="main-content" id="userDashContent">${renderUserDashContent()}</div></div>`;
    loadUserDashData();
}
function renderUserDashContent(){
    switch(userDashTab){
        case 'orders': return `<h3><i class="fas fa-shopping-cart"></i> My Orders</h3><div class="dash-stats"><div class="dash-stat-card"><div class="icon-circle icon-orange"><i class="fas fa-clock"></i></div><div style="font-size:1.5rem;font-weight:700;" id="statPending">-</div><small>Pending</small></div><div class="dash-stat-card"><div class="icon-circle icon-blue"><i class="fas fa-spinner"></i></div><div style="font-size:1.5rem;font-weight:700;" id="statActive">-</div><small>Active</small></div><div class="dash-stat-card"><div class="icon-circle icon-green"><i class="fas fa-check"></i></div><div style="font-size:1.5rem;font-weight:700;" id="statCompleted">-</div><small>Completed</small></div><div class="dash-stat-card"><div class="icon-circle icon-red"><i class="fas fa-times"></i></div><div style="font-size:1.5rem;font-weight:700;" id="statRejected">-</div><small>Rejected</small></div></div><div id="userOrdersList">Loading...</div>`;
        case 'notifications': return `<h3><i class="fas fa-bell"></i> Notifications</h3><div id="userNotificationsList">Loading...</div>`;
        case 'settings': return `<h3><i class="fas fa-cog"></i> Settings</h3><div class="glass-card-static" style="max-width:500px;padding:1.5rem;"><p><strong>Email:</strong> ${currentUser?.email}</p><p><strong>Role:</strong> ${isAdmin?'Admin':'Customer'}</p><button class="btn btn-outline btn-sm" onclick="openChangePasswordModal()" style="margin-top:1rem;"><i class="fas fa-key"></i> Change Password</button><button class="btn btn-outline btn-sm" onclick="logout()" style="margin-top:0.5rem;"><i class="fas fa-sign-out-alt"></i> Logout</button></div>`;
        default: return '<p>Select a tab</p>';
    }
}
async function loadUserDashData(){
    if(!currentUser)return;
    if(userDashTab==='orders'){
        const snap=await db.collection('orders').where('userId','==',currentUser.uid).orderBy('createdAt','desc').get();
        const orders=snap.docs.map(d=>({id:d.id,...d.data()}));
        const stats={pending:0,active:0,completed:0,rejected:0};
        orders.forEach(o=>{if(o.status==='pending')stats.pending++;else if(o.status==='active'||o.status==='processing')stats.active++;else if(o.status==='completed')stats.completed++;else if(o.status==='rejected')stats.rejected++;});
        document.getElementById('statPending').textContent=stats.pending;
        document.getElementById('statActive').textContent=stats.active;
        document.getElementById('statCompleted').textContent=stats.completed;
        document.getElementById('statRejected').textContent=stats.rejected;
        const list=document.getElementById('userOrdersList');
        list.innerHTML=orders.length?orders.map(o=>`<div class="glass-card-static" style="padding:1rem;margin-bottom:0.8rem;"><strong>${o.productName}</strong> ${o.packageName?`(${o.packageName})`:''} — Br ${o.totalPrice?.toFixed(2)} <span class="badge badge-${o.status}">${o.status}</span> ${o.screenshotUrl?`<img src="${o.screenshotUrl}" style="width:50px;height:50px;object-fit:cover;border-radius:8px;cursor:pointer;" onclick="zoomImage('${o.screenshotUrl}')">`:''}<small style="color:var(--text-muted);float:right;">${new Date(o.createdAt).toLocaleDateString()}</small></div>`).join(''):'<p style="text-align:center;color:var(--text-muted);">No orders yet.</p>';
    }else if(userDashTab==='notifications'){
        const snap=await db.collection('notifications').where('targetId','==',currentUser.uid).orderBy('createdAt','desc').limit(30).get();
        document.getElementById('userNotificationsList').innerHTML=snap.docs.length?snap.docs.map(d=>{const n=d.data();return`<div class="glass-card-static" style="padding:1rem;margin-bottom:0.5rem;"><strong>${n.title}</strong><p>${n.message}</p><small>${new Date(n.createdAt).toLocaleString()}</small></div>`;}).join(''):'<p style="text-align:center;color:var(--text-muted);">No notifications yet.</p>';
        const batch=db.batch();snap.docs.forEach(d=>{if(!d.data().read)batch.update(d.ref,{read:true});});await batch.commit();
    }
}

// ==================== CHANGE PASSWORD ====================
function openChangePasswordModal(){
    document.getElementById('modalOverlay').classList.remove('hidden');
    document.getElementById('modalContent').innerHTML=`<button class="close-modal" onclick="closeModal()">&times;</button><h3>Change Password</h3><form onsubmit="changePassword(event)"><div class="form-group"><label>Current Password</label><input type="password" id="currentPassword" required></div><div class="form-group"><label>New Password</label><input type="password" id="newPassword" required minlength="6"></div><div class="form-group"><label>Confirm New Password</label><input type="password" id="confirmNewPassword" required minlength="6"></div><button type="submit" class="btn btn-primary" style="width:100%;">Update Password</button></form>`;
}
async function changePassword(e){
    e.preventDefault();
    const cur=document.getElementById('currentPassword').value;
    const newP=document.getElementById('newPassword').value;
    const conf=document.getElementById('confirmNewPassword').value;
    if(newP!==conf) return showToast('Passwords do not match.','error');
    if(newP.length<6) return showToast('Password must be at least 6 characters.','error');
    try{
        const credential=firebase.auth.EmailAuthProvider.credential(currentUser.email,cur);
        await currentUser.reauthenticateWithCredential(credential);
        await currentUser.updatePassword(newP);
        closeModal();
        showToast('Password updated!','success');
    }catch(err){showToast('Error: '+err.message,'error');}
}

// ==================== HELP MODAL ====================
function openHelpModal(){
    document.getElementById('modalOverlay').classList.remove('hidden');
    document.getElementById('modalContent').innerHTML=`<button class="close-modal" onclick="closeModal()">&times;</button><h3><i class="fas fa-question-circle"></i> How to Use ABM-10 TOPUP</h3><div style="max-height:60vh;overflow-y:auto;"><h4>For Customers</h4><p><strong>1. Browse Services:</strong> Click "Services" in the navigation bar to see all available services. Use the search bar and category filter to find what you need.</p><p><strong>2. Place an Order:</strong> Click on a service, select a package or enter a quantity. Enter your account/ID where the service should be delivered. The total price updates automatically.</p><p><strong>3. Apply a Coupon:</strong> If you have a coupon code, enter it and click "Apply" to get a discount.</p><p><strong>4. Select Payment Method:</strong> Choose from the available payment methods. You can copy the account number by clicking the copy icon.</p><p><strong>5. Upload Screenshot:</strong> Take a screenshot of your payment and upload it. The image must be JPG, PNG, GIF, or WEBP and less than 5MB (it will be compressed automatically).</p><p><strong>6. Submit Order:</strong> Click "Place Order" to complete your purchase. You can track your order status in the Dashboard.</p><h4>For Admins</h4><p><strong>1. Manage Products:</strong> Go to Admin > Products to add, edit, or delete services. For fixed packages, use the "Add Amount" button to create price options.</p><p><strong>2. Manage Orders:</strong> In Admin > Orders, you can accept, reject, or mark orders as completed. The customer's account/ID is displayed. The customer will receive a notification.</p><p><strong>3. Payment Methods:</strong> Add your payment accounts in Admin > Payment Methods.</p><p><strong>4. Coupons:</strong> Create discount coupons in Admin > Coupons.</p><p><strong>5. Users:</strong> Manage users, ban/unban accounts, and promote users to admin in Admin > Users.</p><p><strong>6. Bot Settings:</strong> Configure your Telegram bot in Admin > Settings to receive order notifications.</p></div>`;
}

// ==================== ADMIN DASHBOARD ====================
function renderAdminDashboard(app){
    if(!isAdmin){navigate('home');return;}
    app.innerHTML=`<div class="dashboard-layout"><div class="sidebar" id="adminSidebar"><div style="text-align:center;padding:1rem 0;border-bottom:1px solid var(--border);margin-bottom:1rem;"><i class="fas fa-shield-alt fa-3x" style="color:var(--gold-light);"></i><p style="margin-top:0.5rem;font-weight:600;">Admin Panel</p><span class="badge badge-info">Administrator</span></div><ul class="sidebar-nav"><li><a class="${adminSubView==='overview'?'active':''}" onclick="setAdminSubView('overview')"><i class="fas fa-chart-pie"></i> Overview</a></li><li><a class="${adminSubView==='orders'?'active':''}" onclick="setAdminSubView('orders')"><i class="fas fa-shopping-cart"></i> Orders ${notificationCount>0?`<span class="badge badge-pending" style="margin-left:auto;">${notificationCount}</span>`:''}</a></li><li><a class="${adminSubView==='products'?'active':''}" onclick="setAdminSubView('products')"><i class="fas fa-box"></i> Products</a></li><li><a class="${adminSubView==='payments'?'active':''}" onclick="setAdminSubView('payments')"><i class="fas fa-credit-card"></i> Payment Methods</a></li><li><a class="${adminSubView==='users'?'active':''}" onclick="setAdminSubView('users')"><i class="fas fa-users"></i> Users</a></li><li><a class="${adminSubView==='announcements'?'active':''}" onclick="setAdminSubView('announcements')"><i class="fas fa-bullhorn"></i> Announcements</a></li><li><a class="${adminSubView==='coupons'?'active':''}" onclick="setAdminSubView('coupons')"><i class="fas fa-ticket-alt"></i> Coupons</a></li><li><a class="${adminSubView==='settings'?'active':''}" onclick="setAdminSubView('settings')"><i class="fas fa-cog"></i> Settings</a></li><li><a onclick="logout()"><i class="fas fa-sign-out-alt"></i> Logout</a></li></ul></div><div class="main-content" id="adminMainContent">${renderAdminSubViewContent()}</div></div>`;
    loadAdminSubViewData();
}
function renderAdminSubViewContent(){
    switch(adminSubView){
        case 'overview': return `<h3>Overview</h3><div class="dash-stats" id="adminStatsContainer">Loading...</div><h4>Recent Orders</h4><div id="adminRecentOrdersList">Loading...</div>`;
        case 'orders': return `<h3>Orders</h3><input type="text" id="adminOrderSearch" placeholder="Search..." oninput="loadAdminOrders()" style="margin-bottom:1rem;"><select id="adminOrderStatusFilter" onchange="loadAdminOrders()"><option value="">All</option><option>pending</option><option>active</option><option>completed</option><option>rejected</option></select><div id="adminOrdersList">Loading...</div>`;
        case 'products': return `<h3>Products</h3><button class="btn btn-primary btn-sm" onclick="openProductModal()"><i class="fas fa-plus"></i> Add Product</button><div id="adminProductsList" style="margin-top:1rem;">Loading...</div>`;
        case 'payments': return `<h3>Payment Methods</h3><button class="btn btn-primary btn-sm" onclick="openPaymentMethodModal()"><i class="fas fa-plus"></i> Add Method</button><div id="adminPaymentsList" style="margin-top:1rem;">Loading...</div>`;
        case 'users': return `<h3>Users</h3><div id="adminUsersList">Loading...</div>`;
        case 'announcements': return `<h3>Announcements</h3><button class="btn btn-primary btn-sm" onclick="openAnnouncementModal()"><i class="fas fa-plus"></i> Send</button><div id="adminAnnouncementsList" style="margin-top:1rem;">Loading...</div>`;
        case 'coupons': return `<h3>Coupons</h3><button class="btn btn-primary btn-sm" onclick="openCouponModal()"><i class="fas fa-plus"></i> Create</button><div id="adminCouponsList" style="margin-top:1rem;">Loading...</div>`;
        case 'settings': return `<h3>Settings</h3><div class="glass-card-static" style="max-width:600px;padding:1.5rem;"><h4>Telegram Bot Settings</h4><p style="color:var(--text-muted);">Receive order notifications via Telegram bot.</p><div class="form-group"><label>Bot Token</label><input type="text" id="botToken" placeholder="123456:ABC-DEF1234ghikl" value="${botSettings?.token||''}"></div><div class="form-group"><label>Your Telegram User ID</label><input type="text" id="botUserId" placeholder="123456789" value="${botSettings?.userId||''}"></div><button class="btn btn-primary btn-sm" id="saveBotSettingsBtn" onclick="saveBotSettings()"><i class="fas fa-save"></i> Save Bot Settings</button><p style="margin-top:1rem;font-size:0.8rem;color:var(--text-muted);">Get your User ID from <a href="https://t.me/userinfobot" target="_blank" style="color:var(--gold-light);">@userinfobot</a></p></div>`;
        default: return '<p>Select a section</p>';
    }
}
async function loadAdminSubViewData(){
    if(!isAdmin)return;
    if(adminSubView==='overview')await loadAdminOverview();
    else if(adminSubView==='orders')await loadAdminOrders();
    else if(adminSubView==='products')await loadAdminProducts();
    else if(adminSubView==='payments')await loadAdminPaymentMethods();
    else if(adminSubView==='users')await loadAdminUsers();
    else if(adminSubView==='announcements')await loadAdminAnnouncements();
    else if(adminSubView==='coupons')await loadAdminCoupons();
}
async function loadAdminOverview(){
    const[ordersSnap,usersSnap]=await Promise.all([db.collection('orders').get(),db.collection('users').get()]);
    const orders=ordersSnap.docs.map(d=>d.data());
    const rev=orders.filter(o=>o.status==='completed').reduce((s,o)=>s+(o.totalPrice||0),0);
    document.getElementById('adminStatsContainer').innerHTML=`<div class="dash-stat-card"><div class="icon-circle icon-blue"><i class="fas fa-dollar-sign"></i></div><div style="font-size:1.5rem;font-weight:700;">Br ${rev.toFixed(2)}</div><small>Revenue</small></div><div class="dash-stat-card"><div class="icon-circle icon-blue"><i class="fas fa-users"></i></div><div style="font-size:1.5rem;font-weight:700;">${usersSnap.size}</div><small>Users</small></div><div class="dash-stat-card"><div class="icon-circle icon-orange"><i class="fas fa-clock"></i></div><div style="font-size:1.5rem;font-weight:700;">${orders.filter(o=>o.status==='pending').length}</div><small>Pending</small></div><div class="dash-stat-card"><div class="icon-circle icon-green"><i class="fas fa-check-circle"></i></div><div style="font-size:1.5rem;font-weight:700;">${orders.filter(o=>o.status==='completed').length}</div><small>Completed</small></div>`;
    document.getElementById('adminRecentOrdersList').innerHTML=ordersSnap.docs.slice(-8).reverse().map(d=>{const o=d.data();return`<div class="glass-card-static" style="padding:0.8rem;margin-bottom:0.5rem;">${o.userEmail} - ${o.productName} - Br ${o.totalPrice?.toFixed(2)} <span class="badge badge-${o.status}">${o.status}</span> ${o.screenshotUrl?`<img src="${o.screenshotUrl}" style="width:30px;height:30px;border-radius:4px;cursor:pointer;" onclick="zoomImage('${o.screenshotUrl}')">`:''}</div>`;}).join('')||'<p>No orders.</p>';
}
async function loadAdminOrders(){
    if(!allPaymentMethods.length){
        const snap = await db.collection('paymentMethods').get();
        allPaymentMethods = snap.docs.map(d=>({id:d.id,...d.data()}));
    }
    const search=(document.getElementById('adminOrderSearch')?.value||'').toLowerCase();
    const filter=document.getElementById('adminOrderStatusFilter')?.value||'';
    let query=db.collection('orders').orderBy('createdAt','desc');
    if(filter)query=query.where('status','==',filter);
    const snap=await query.get();
    let orders=snap.docs.map(d=>({id:d.id,...d.data()}));
    if(search)orders=orders.filter(o=>o.userEmail?.toLowerCase().includes(search)||o.productName?.toLowerCase().includes(search)||(o.customerAccount||'').toLowerCase().includes(search));
    const container=document.getElementById('adminOrdersList');
    if(orders.length===0) { container.innerHTML='<p>No orders found.</p>'; return; }
    container.innerHTML=orders.map(o=>{
        const pm = allPaymentMethods.find(m=>m.id===o.paymentMethodId);
        const pmName = pm ? pm.name : 'Unknown';
        return `<div class="glass-card-static" style="padding:1rem;margin-bottom:0.5rem;">
            <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;">
                <strong>${o.userEmail}</strong>
                <span class="badge badge-${o.status}">${o.status}</span>
            </div>
            <div style="margin-top:0.3rem;">
                <strong>${o.productName}</strong> ${o.packageName?`(${o.packageName})`:''}
            </div>
            <div style="font-size:0.9rem;color:var(--text-secondary);margin:0.3rem 0;">
                Account: <strong>${o.customerAccount || 'N/A'}</strong><br>
                Qty: ${o.quantity} | Method: ${pmName} | Total: Br ${o.totalPrice?.toFixed(2)}
            </div>
            ${o.screenshotUrl ? `<img src="${o.screenshotUrl}" style="width:50px;height:50px;border-radius:6px;cursor:pointer;margin-right:8px;" onclick="zoomImage('${o.screenshotUrl}')">` : ''}
            <div style="margin-top:0.5rem;">
                ${o.status==='pending' ? `<button class="btn btn-success btn-sm" onclick="updateOrderStatus('${o.id}','active')">Accept</button> <button class="btn btn-danger btn-sm" onclick="updateOrderStatus('${o.id}','rejected')">Reject</button>` : ''}
                ${o.status==='active' ? `<button class="btn btn-primary btn-sm" onclick="updateOrderStatus('${o.id}','completed')">Mark Completed</button>` : ''}
            </div>
        </div>`;
    }).join('');
}
async function updateOrderStatus(orderId,newStatus){
    if(!await showConfirmDialog(`Mark order as "${newStatus}"?`))return;
    await db.collection('orders').doc(orderId).update({status:newStatus,updatedAt:Date.now()});
    const orderDoc=await db.collection('orders').doc(orderId).get();
    const order=orderDoc.data();
    if(order)await db.collection('notifications').add({targetId:order.userId,title:`Order ${newStatus}`,message:`Your order for ${order.productName} has been ${newStatus}.`,read:false,createdAt:Date.now()});
    showToast(`Order ${newStatus}!`,'success');
    loadAdminOrders();
}
async function loadAdminProducts(){
    const snap=await db.collection('products').get();
    allProducts=snap.docs.map(d=>({id:d.id,...d.data()}));
    document.getElementById('adminProductsList').innerHTML=allProducts.length?`<div class="table-container"><table><tr><th>Image</th><th>Name</th><th>Category</th><th>Price</th><th>Actions</th></tr>${allProducts.map(p=>{const pd=p.orderType==='fixed'&&p.amounts?.length?`From Br ${Math.min(...p.amounts.map(a=>a.price)).toFixed(2)}`:`Br ${(p.price||0).toFixed(2)}`;return`<tr><td>${p.imageUrl?`<img src="${p.imageUrl}" style="width:40px;height:40px;border-radius:6px;">`:`<i class="fas ${getCategoryIcon(p.category)}"></i>`}</td><td>${p.name}</td><td>${p.category}</td><td>${pd}</td><td><button class="btn btn-outline btn-sm" onclick="openProductModal('${p.id}')">Edit</button> <button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')">Delete</button></td></tr>`;}).join('')}</table></div>`:'<p>No products yet.</p>';
}
function openProductModal(productId=null){
    const product=productId?allProducts.find(p=>p.id===productId):null;
    document.getElementById('modalOverlay').classList.remove('hidden');
    const amounts=product?.amounts||product?.packages||[];
    let amountsHTML='';
    if(product?.orderType==='fixed'||!product){
        amountsHTML=`<div id="amountsContainer">${amounts.map((a,i)=>`<div class="amount-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><input type="text" placeholder="Name" value="${a.name||''}" class="amount-name" style="flex:1;"><input type="number" placeholder="Price" step="0.01" value="${a.price||''}" class="amount-price" style="width:100px;"><input type="text" placeholder="Note (optional)" value="${a.note||''}" class="amount-note" style="flex:2;"><button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button></div>`).join('')}</div><button type="button" class="btn btn-outline btn-sm" onclick="addAmountRow()"><i class="fas fa-plus"></i> Add Amount</button>`;
    }
    document.getElementById('modalContent').innerHTML=`<button class="close-modal" onclick="closeModal()">&times;</button><h3>${product?'Edit':'Add'} Product</h3><form onsubmit="saveProduct(event,'${productId||''}')"><div class="form-group"><label>Name</label><input type="text" id="prodName" value="${product?.name||''}" required></div><div class="form-group"><label>Category</label><select id="prodCategory">${['Telegram Services','TikTok Services','Instagram Services','YouTube Services','PUBG UC','Free Fire Diamonds','Other Digital Services','Accounts/Channels'].map(c=>`<option ${product?.category===c?'selected':''}>${c}</option>`).join('')}</select></div><div class="form-group"><label>Description</label><textarea id="prodDescription">${product?.description||''}</textarea></div><div class="form-group"><label>Image</label><input type="file" id="prodImageFile" accept="image/*"> ${product?.imageUrl?`<img src="${product.imageUrl}" style="width:80px;border-radius:8px;">`:''}</div><div class="form-group"><label>Order Type</label><select id="prodOrderType" onchange="toggleProductTypeFields()"><option value="custom" ${product?.orderType==='custom'||!product?'selected':''}>Custom Quantity</option><option value="fixed" ${product?.orderType==='fixed'?'selected':''}>Fixed Package</option></select></div><div id="customFields" class="${product?.orderType==='fixed'?'hidden':''}"><div class="form-group"><label>Price per unit</label><input type="number" id="prodPrice" step="0.01" value="${product?.price||0}"></div><div class="form-group"><label>Min Qty</label><input type="number" id="prodMinQty" value="${product?.minQty||10}"></div><div class="form-group"><label>Max Qty</label><input type="number" id="prodMaxQty" value="${product?.maxQty||100000}"></div></div><div id="fixedFields" class="${product?.orderType!=='fixed'?'hidden':''}"><label>Amounts / Packages</label>${amountsHTML}<small style="color:var(--text-muted);">Add each amount with name, price, and optional note.</small></div><div class="form-group"><label>Delivery Time</label><input type="text" id="prodDeliveryTime" value="${product?.deliveryTime||'1-24 hours'}"></div><div class="form-group"><label>Status</label><select id="prodStatus"><option value="active" ${product?.status==='active'||!product?'selected':''}>Active</option><option value="disabled" ${product?.status==='disabled'?'selected':''}>Disabled</option></select></div><button type="submit" class="btn btn-primary" style="width:100%;" id="productSaveBtn">Save Product</button></form>`;
    toggleProductTypeFields();
}
window.addAmountRow=function(name='',price='',note=''){
    const container=document.getElementById('amountsContainer');
    if(!container)return;
    const row=document.createElement('div');row.className='amount-row';row.style.cssText='display:flex;gap:8px;align-items:center;margin-bottom:6px;';
    row.innerHTML=`<input type="text" placeholder="Name" value="${name}" class="amount-name" style="flex:1;"><input type="number" placeholder="Price" step="0.01" value="${price}" class="amount-price" style="width:100px;"><input type="text" placeholder="Note (optional)" value="${note}" class="amount-note" style="flex:2;"><button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>`;
    container.appendChild(row);
};
function toggleProductTypeFields(){
    const type=document.getElementById('prodOrderType')?.value;
    document.getElementById('customFields')?.classList.toggle('hidden',type==='fixed');
    document.getElementById('fixedFields')?.classList.toggle('hidden',type==='custom');
}
async function saveProduct(e,productId){
    e.preventDefault();
    const btn=document.getElementById('productSaveBtn');const orig=btn.innerHTML;
    btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Saving...';
    const orderType=document.getElementById('prodOrderType').value;
    const data={name:document.getElementById('prodName').value,category:document.getElementById('prodCategory').value,description:document.getElementById('prodDescription').value,orderType,deliveryTime:document.getElementById('prodDeliveryTime').value,status:document.getElementById('prodStatus').value,updatedAt:Date.now()};
    if(orderType==='custom'){data.price=parseFloat(document.getElementById('prodPrice').value)||0;data.minQty=parseInt(document.getElementById('prodMinQty').value)||10;data.maxQty=parseInt(document.getElementById('prodMaxQty').value)||100000;data.amounts=null;}
    else{const rows=document.querySelectorAll('#amountsContainer .amount-row');const amounts=[];rows.forEach(row=>{const n=row.querySelector('.amount-name')?.value.trim();const p=parseFloat(row.querySelector('.amount-price')?.value)||0;const nt=row.querySelector('.amount-note')?.value.trim()||'';if(n&&p)amounts.push({name:n,price:p,note:nt});});if(!amounts.length){showToast('Add at least one amount.','error');btn.disabled=false;btn.innerHTML=orig;return;}data.amounts=amounts;data.price=amounts[0].price;data.packages=null;}
    const file=document.getElementById('prodImageFile')?.files[0];
    if(file){if(file.size>400*1024){showToast('Image size must be less than 400KB.','error');btn.disabled=false;btn.innerHTML=orig;return;}if(!['image/jpeg','image/png','image/gif','image/webp'].includes(file.type)){showToast('Please upload a valid image.','error');btn.disabled=false;btn.innerHTML=orig;return;}const reader=new FileReader();reader.onload=async(ev)=>{data.imageUrl=ev.target.result;await saveProductData(productId,data,btn,orig);};reader.readAsDataURL(file);}
    else{if(productId){const existing=allProducts.find(p=>p.id===productId);if(existing?.imageUrl)data.imageUrl=existing.imageUrl;}await saveProductData(productId,data,btn,orig);}
}
async function saveProductData(productId,data,btn,orig){try{if(productId)await db.collection('products').doc(productId).update(data);else{data.createdAt=Date.now();await db.collection('products').add(data);}setCache(CACHE_KEY_PRODUCTS,null);closeModal();showToast('Product saved!','success');loadAdminProducts();}catch(err){showToast('Error: '+err.message,'error');}finally{btn.disabled=false;btn.innerHTML=orig;}}
async function deleteProduct(id){if(!await showConfirmDialog('Delete this product?'))return;await db.collection('products').doc(id).delete();setCache(CACHE_KEY_PRODUCTS,null);showToast('Product deleted.','info');loadAdminProducts();}
async function loadAdminPaymentMethods(){
    const snap=await db.collection('paymentMethods').get();
    allPaymentMethods=snap.docs.map(d=>({id:d.id,...d.data()}));
    document.getElementById('adminPaymentsList').innerHTML=allPaymentMethods.length?allPaymentMethods.map(m=>`<div class="glass-card-static" style="padding:1rem;margin-bottom:0.5rem;display:flex;justify-content:space-between;"><div><strong>${m.name}</strong> — ${m.accountNumber}</div><div><button class="btn btn-outline btn-sm" onclick="openPaymentMethodModal('${m.id}')">Edit</button> <button class="btn btn-danger btn-sm" onclick="deletePaymentMethod('${m.id}')">Delete</button></div></div>`).join(''):'<p>No payment methods.</p>';
}
function openPaymentMethodModal(methodId=null){const method=methodId?allPaymentMethods.find(m=>m.id===methodId):null;document.getElementById('modalOverlay').classList.remove('hidden');document.getElementById('modalContent').innerHTML=`<button class="close-modal" onclick="closeModal()">&times;</button><h3>${method?'Edit':'Add'} Payment Method</h3><form onsubmit="savePaymentMethod(event,'${methodId||''}')"><div class="form-group"><label>Name</label><input type="text" id="pmName" value="${method?.name||''}" required></div><div class="form-group"><label>Account Number</label><input type="text" id="pmAccount" value="${method?.accountNumber||''}" required></div><div class="form-group"><label>Instructions</label><textarea id="pmInstructions">${method?.instructions||''}</textarea></div><button type="submit" class="btn btn-primary" style="width:100%;">Save Method</button></form>`;}
async function savePaymentMethod(e,methodId){e.preventDefault();const data={name:document.getElementById('pmName').value,accountNumber:document.getElementById('pmAccount').value,instructions:document.getElementById('pmInstructions').value};if(methodId)await db.collection('paymentMethods').doc(methodId).update(data);else await db.collection('paymentMethods').add({...data,createdAt:Date.now()});setCache(CACHE_KEY_PAYMENTS,null);closeModal();showToast('Payment method saved!','success');loadAdminPaymentMethods();}
async function deletePaymentMethod(id){if(!await showConfirmDialog('Delete this method?'))return;await db.collection('paymentMethods').doc(id).delete();setCache(CACHE_KEY_PAYMENTS,null);showToast('Deleted.','info');loadAdminPaymentMethods();}
async function loadAdminUsers(){
    const snap=await db.collection('users').get();
    const users=snap.docs.map(d=>({id:d.id,...d.data()}));
    document.getElementById('adminUsersList').innerHTML=`<div class="table-container"><table><tr><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr>${users.map(u=>`<tr><td>${u.email}</td><td>${u.role||'user'}${u.role!=='admin'?` <button class="btn btn-outline btn-sm" onclick="toggleAdminRole('${u.id}')" style="font-size:0.7rem;">Make Admin</button>`:u.id!==currentUser?.uid?` <button class="btn btn-outline btn-sm" onclick="toggleAdminRole('${u.id}')" style="font-size:0.7rem;">Remove Admin</button>`:''}</td><td><span class="badge ${u.status==='banned'?'badge-rejected':'badge-active'}">${u.status||'active'}</span></td><td><button class="btn btn-outline btn-sm" onclick="toggleUserStatus('${u.id}','${u.status||'active'}')">${u.status==='banned'?'Unban':'Ban'}</button> ${u.role!=='admin'?`<button class="btn btn-danger btn-sm" onclick="deleteUser('${u.id}')">Delete</button>`:''}</td></tr>`).join('')}</table></div>`;
}
async function toggleAdminRole(uid){
    const userDoc=await db.collection('users').doc(uid).get();
    const data=userDoc.data();
    const newRole=data.role==='admin'?'user':'admin';
    if(!await showConfirmDialog(`${newRole==='admin'?'Promote':'Demote'} this user to ${newRole}?`))return;
    await db.collection('users').doc(uid).update({role:newRole,updatedAt:Date.now()});
    showToast(`User is now ${newRole}.`,'success');
    loadAdminUsers();
}
async function toggleUserStatus(uid,cur){if(!await showConfirmDialog(`${cur==='banned'?'Unban':'Ban'} this user?`))return;const ns=cur==='banned'?'active':'banned';await db.collection('users').doc(uid).update({status:ns,updatedAt:Date.now()});showToast(`User ${ns}.`,'info');loadAdminUsers();}
async function deleteUser(uid){if(!await showConfirmDialog('Delete this user?'))return;await db.collection('users').doc(uid).delete();showToast('User deleted.','info');loadAdminUsers();}
async function loadAdminAnnouncements(){
    const snap=await db.collection('announcements').orderBy('createdAt','desc').get();
    document.getElementById('adminAnnouncementsList').innerHTML=snap.docs.length?snap.docs.map(d=>{const a=d.data();return`<div class="glass-card-static" style="padding:1rem;margin-bottom:0.5rem;"><strong>${a.title}</strong><p>${a.message}</p><small>${new Date(a.createdAt).toLocaleString()}</small> <button class="btn btn-danger btn-sm" onclick="deleteAnnouncement('${d.id}')">Delete</button></div>`;}).join(''):'<p>No announcements.</p>';
}
function openAnnouncementModal(){document.getElementById('modalOverlay').classList.remove('hidden');document.getElementById('modalContent').innerHTML=`<button class="close-modal" onclick="closeModal()">&times;</button><h3>Send Announcement</h3><form onsubmit="sendAnnouncement(event)"><div class="form-group"><label>Title</label><input type="text" id="annTitle" required></div><div class="form-group"><label>Message</label><textarea id="annMessage" required></textarea></div><button type="submit" class="btn btn-primary" style="width:100%;">Send to All Users</button></form>`;}
async function sendAnnouncement(e){e.preventDefault();const title=document.getElementById('annTitle').value,message=document.getElementById('annMessage').value;await db.collection('announcements').add({title,message,createdAt:Date.now()});const snap=await db.collection('users').where('role','==','user').get();const batch=db.batch();snap.docs.forEach(u=>batch.set(db.collection('notifications').doc(),{targetId:u.id,title,message,read:false,createdAt:Date.now()}));await batch.commit();closeModal();showToast('Announcement sent!','success');loadAdminAnnouncements();}
async function deleteAnnouncement(id){if(!await showConfirmDialog('Delete?'))return;await db.collection('announcements').doc(id).delete();showToast('Deleted.','info');loadAdminAnnouncements();}
async function loadAdminCoupons(){
    const snap=await db.collection('coupons').get();
    document.getElementById('adminCouponsList').innerHTML=snap.docs.length?snap.docs.map(d=>{const c=d.data();return`<div class="glass-card-static" style="padding:1rem;margin-bottom:0.5rem;display:flex;justify-content:space-between;"><div><strong>${c.code}</strong> (${c.discount}% off) Used: ${c.used||0}/${c.maxUsage||'∞'}</div><button class="btn btn-danger btn-sm" onclick="deleteCoupon('${d.id}')">Delete</button></div>`;}).join(''):'<p>No coupons.</p>';
}
function openCouponModal(){document.getElementById('modalOverlay').classList.remove('hidden');document.getElementById('modalContent').innerHTML=`<button class="close-modal" onclick="closeModal()">&times;</button><h3>Create Coupon</h3><form onsubmit="createCoupon(event)"><div class="form-group"><label>Code</label><input type="text" id="couponCode" style="text-transform:uppercase;" required></div><div class="form-group"><label>Discount (%)</label><input type="number" id="couponDiscount" min="1" max="100" required></div><div class="form-group"><label>Max Uses (0=unlimited)</label><input type="number" id="couponMaxUsage" value="0"></div><div class="form-group"><label>Expiry Date</label><input type="date" id="couponExpiry"></div><button type="submit" class="btn btn-primary" style="width:100%;">Create Coupon</button></form>`;}
async function createCoupon(e){e.preventDefault();await db.collection('coupons').add({code:document.getElementById('couponCode').value.toUpperCase().trim(),discount:parseInt(document.getElementById('couponDiscount').value),maxUsage:parseInt(document.getElementById('couponMaxUsage').value)||0,expiresAt:document.getElementById('couponExpiry').value?new Date(document.getElementById('couponExpiry').value).getTime():null,used:0,createdAt:Date.now()});closeModal();showToast('Coupon created!','success');loadAdminCoupons();}
async function deleteCoupon(id){if(!await showConfirmDialog('Delete?'))return;await db.collection('coupons').doc(id).delete();showToast('Deleted.','info');loadAdminCoupons();}

// ==================== BOT SETTINGS ====================
async function saveBotSettings(){
    const btn = document.getElementById('saveBotSettingsBtn');
    const origText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    const token = document.getElementById('botToken').value.trim();
    const userId = document.getElementById('botUserId').value.trim();
    if (!token || !userId) {
        showToast('Please fill both fields.', 'error');
        btn.disabled = false;
        btn.innerHTML = origText;
        return;
    }
    try {
        await db.collection('settings').doc('bot').set({ token, userId });
        botSettings = { token, userId };
        showToast('Bot settings saved!', 'success');
    } catch (err) {
        showToast('Error: ' + err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origText;
    }
}

// ==================== UTILITIES ====================
function copyToClipboard(text){navigator.clipboard.writeText(text).then(()=>showToast('Copied!','success')).catch(()=>showToast('Failed to copy.','error'));}
function zoomImage(url){document.getElementById('imgZoomSrc').src=url;document.getElementById('imgZoomOverlay').classList.remove('hidden');}
function closeImageZoom(){document.getElementById('imgZoomOverlay').classList.add('hidden');}
function closeModal(e){if(e&&e.target!==document.getElementById('modalOverlay'))return;document.getElementById('modalOverlay').classList.add('hidden');}
function showToast(message,type='info'){const t=document.createElement('div');t.className=`toast toast-${type}`;t.textContent=message;document.getElementById('toastContainer').appendChild(t);setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity 0.3s';setTimeout(()=>t.remove(),300);},3500);}
function showConfirmDialog(message){return new Promise(resolve=>{document.getElementById('confirmMessage').textContent=message;const overlay=document.getElementById('confirmOverlay');overlay.classList.remove('hidden');document.getElementById('confirmYes').onclick=()=>{overlay.classList.add('hidden');resolve(true);};document.getElementById('confirmNo').onclick=()=>{overlay.classList.add('hidden');resolve(false);};});}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.getElementById('modalOverlay').classList.add('hidden');document.getElementById('imgZoomOverlay').classList.add('hidden');document.getElementById('confirmOverlay').classList.add('hidden');}});

// ==================== START ====================
document.addEventListener('DOMContentLoaded',()=>{
    const helpBtn=document.createElement('button');
    helpBtn.className='help-float';
    helpBtn.innerHTML='<i class="fas fa-question"></i>';
    helpBtn.title='Help';
    helpBtn.onclick=openHelpModal;
    document.body.appendChild(helpBtn);
    const navbar = document.getElementById('navbar');
    const themeToggleBtn = document.createElement('button');
    themeToggleBtn.id = 'themeToggleBtn';
    themeToggleBtn.className = 'theme-toggle';
    themeToggleBtn.title = 'Toggle theme';
    themeToggleBtn.onclick = toggleTheme;
    const hamburger = navbar.querySelector('.hamburger');
    navbar.insertBefore(themeToggleBtn, hamburger);
    updateThemeToggleIcon();
    render();
    updateNavUI();
    console.log('🚀 ABM-10 TOPUP SMM Panel ready!');
});
