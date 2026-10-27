import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, money, setToken, uploadImage } from './api.js';

/* ───────── category colour system ───────── */
const THEMES = {
  Electronics: { solid: '#2A4DFF', tint: '#DCE3FF', on: '#FFFFFF', icon: '🎧' },
  Clothing: { solid: '#FF6B57', tint: '#FFDDD6', on: '#14182B', icon: '👕' },
  Books: { solid: '#16825A', tint: '#D3F0E3', on: '#FFFFFF', icon: '📘' },
  Home: { solid: '#FFB61E', tint: '#FFEDC2', on: '#14182B', icon: '☕' },
};
const FALLBACKS = [
  { solid: '#7A3EF0', tint: '#E8DEFF', on: '#FFFFFF', icon: '🎁' },
  { solid: '#0E8DA6', tint: '#D2F0F6', on: '#FFFFFF', icon: '🧺' },
  { solid: '#D6336C', tint: '#FFDCE8', on: '#FFFFFF', icon: '🛍️' },
];
function themeFor(name = '') {
  if (THEMES[name]) return THEMES[name];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 997;
  return FALLBACKS[h % FALLBACKS.length];
}

/* ───────── helpers ───────── */
const label = (k) => {
  const s = k.replace(/([A-Z])/g, ' $1').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
function formatValue(v) {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (v && typeof v === 'object') return Object.entries(v).map(([k, x]) => `${label(k)}: ${formatValue(x)}`).join(', ');
  return String(v);
}

function useEscape(fn) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') fn(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [fn]);
}

const PRODUCT_IMAGES = {
  "4K Action Camera": "https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=640&auto=format&fit=crop&q=80",
  "Ceramic Pour-Over Set": "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=640&auto=format&fit=crop&q=80",
  "Cotton Crew T-Shirt": "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=640&auto=format&fit=crop&q=80",
  "Insulated Hoodie": "https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=640&auto=format&fit=crop&q=80",
  "LED Desk Lamp": "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=640&auto=format&fit=crop&q=80",
  "Mechanical Keyboard": "https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=640&auto=format&fit=crop&q=80",
  "Site Reliability Engineering": "https://images.unsplash.com/photo-1532012197267-da84d127e765?w=640&auto=format&fit=crop&q=80",
  "Smart Fitness Band": "https://images.unsplash.com/photo-1544117519-31a4b719223d?w=640&auto=format&fit=crop&q=80",
  "Standing Desk Mat": "https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=640&auto=format&fit=crop&q=80",
  "The Pragmatic Programmer": "https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=640&auto=format&fit=crop&q=80",
  "Trail Running Shoes": "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=640&auto=format&fit=crop&q=80",
  "Wireless Earbuds Pro": "https://images.unsplash.com/photo-1606220945770-b5b6c2c55bf1?w=640&auto=format&fit=crop&q=80",
};

function Visual({ image, size, name }) {
  const [failed, setFailed] = useState(false);
  const isImageUrl = typeof image === 'string' && /^(https?:\/\/|\/)/.test(image);
  const mappedImage = name ? PRODUCT_IMAGES[name] : null;
  const src = isImageUrl ? image : mappedImage || null;

  if (src && !failed) {
    return (
      <img
        className="visual-img"
        src={src}
        alt={name || ""}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className="emoji"
      style={size ? { fontSize: size } : undefined}
      aria-hidden="true"
    >
      {image && !/^(https?:\/\/|\/)/.test(image) ? image : '📦'}
    </span>
  );
}

function Dialog({ onClose, name, side, children }) {
  const ref = useRef();
  useEscape(onClose);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className={side ? 'overlay side' : 'overlay'} onClick={onClose}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={name}
        className={side ? 'drawer' : 'dialog'} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/* ───────── auth ───────── */
function AuthDialog({ onClose, onAuthed }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const isLogin = mode === 'login';

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const data = await api(`/users/${mode}`, { method: 'POST', auth: false, body: form });
      setToken(data.token);
      onAuthed(data.user);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <Dialog onClose={onClose} name={isLogin ? 'Log in' : 'Create account'}>
      <form className="stack" onSubmit={submit}>
        <h2 className="dialog-title">{isLogin ? 'Log in to Kart' : 'Create your account'}</h2>
        {!isLogin && <input aria-label="Full name" placeholder="Full name" value={form.name} onChange={set('name')} required autoFocus />}
        <input type="email" aria-label="Email" placeholder="Email" value={form.email} onChange={set('email')} required autoFocus={isLogin} />
        <input type="password" aria-label="Password" placeholder={isLogin ? 'Password' : 'Password, at least 8 characters'}
          value={form.password} onChange={set('password')} required minLength={isLogin ? undefined : 8} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Working…' : isLogin ? 'Log in' : 'Create account'}</button>
        <p className="hint center">
          {isLogin ? 'New to Kart?' : 'Already have an account?'}{' '}
          <button type="button" className="link" onClick={() => { setError(''); setMode(isLogin ? 'register' : 'login'); }}>
            {isLogin ? 'Create an account' : 'Log in'}
          </button>
        </p>
      </form>
    </Dialog>
  );
}

/* ───────── product detail ───────── */
function ProductDialog({ product, onClose, onAdd }) {
  const t = themeFor(product.category);
  const low = product.stock > 0 && product.stock <= 10;
  return (
    <Dialog onClose={onClose} name={product.name}>
      <div className="detail-art" style={{ background: t.tint }}><Visual image={product.image} size="6rem" name={product.name} /></div>
      <div className="detail-head">
        <h2 className="dialog-title">{product.name}</h2>
        <span className="price big">{money(product.price)}</span>
      </div>
      <p className="meta">
        <span className="tag" style={{ background: t.tint }}>{product.category}</span>
        <span className={product.stock < 1 ? 'stock out' : low ? 'stock low' : 'stock'}>
          {product.stock < 1 ? 'Out of stock' : low ? `Only ${product.stock} left` : 'In stock'}
        </span>
      </p>
      <p className="desc">{product.description}</p>
      {product.attributes && Object.keys(product.attributes).length > 0 && (
        <dl className="specs">
          {Object.entries(product.attributes).map(([k, v]) => (
            <React.Fragment key={k}><dt>{label(k)}</dt><dd>{formatValue(v)}</dd></React.Fragment>
          ))}
        </dl>
      )}
      <button className="btn btn-primary btn-block" disabled={product.stock < 1} onClick={() => onAdd(product)}>
        {product.stock < 1 ? 'Out of stock' : 'Add to cart'}
      </button>
    </Dialog>
  );
}

/* ───────── cart ───────── */
function CartDrawer({ cart, onClose, onQty, onCheckout, busy, loggedIn, onLogin }) {
  const [address, setAddress] = useState('');
  return (
    <Dialog onClose={onClose} name="Your cart" side>
      <div className="drawer-head">
        <h2 className="dialog-title">Your cart</h2>
        <button className="btn btn-quiet btn-round" aria-label="Close cart" onClick={onClose}>✕</button>
      </div>

      {!loggedIn && (
        <div className="empty">
          <p>Log in to see what's in your cart.</p>
          <button className="btn btn-primary" onClick={onLogin}>Log in</button>
        </div>
      )}
      {loggedIn && cart.items.length === 0 && (
        <div className="empty">
          <p>Your cart is empty. Add something from the shop.</p>
          <button className="btn btn-quiet" onClick={onClose}>Keep shopping</button>
        </div>
      )}

      <ul className="lines">
        {cart.items.map((it) => (
          <li className="line" key={it.productId}>
            <div className="thumb"><Visual image={it.image} size="1.6rem" /></div>
            <div className="line-info">
              <strong>{it.name}</strong>
              <span className="hint">{money(it.price)} each</span>
            </div>
            <div className="stepper" role="group" aria-label={`Quantity of ${it.name}`}>
              <button aria-label="Decrease quantity" onClick={() => onQty(it.productId, it.qty - 1)}>−</button>
              <span aria-live="polite">{it.qty}</span>
              <button aria-label="Increase quantity" onClick={() => onQty(it.productId, it.qty + 1)}>+</button>
            </div>
          </li>
        ))}
      </ul>

      {cart.items.length > 0 && (
        <div className="checkout">
          <textarea aria-label="Shipping address" placeholder="Shipping address" value={address} onChange={(e) => setAddress(e.target.value)} rows={3} />
          <div className="total"><span>Total</span><strong>{money(cart.total)}</strong></div>
          <button className="btn btn-primary btn-block" disabled={busy || !address.trim()} onClick={() => onCheckout(address)}>
            {busy ? 'Placing order…' : 'Place order'}
          </button>
          {!address.trim() && <p className="hint center">Add a shipping address to place your order.</p>}
        </div>
      )}
    </Dialog>
  );
}

/* ───────── orders ───────── */
function Progress({ status }) {
  const steps = status === 'CANCELLED' ? ['Order placed', 'Cancelled'] : ['Order placed', 'Reserving stock', 'Confirmed'];
  const done = status === 'PENDING' ? 1 : status === 'CONFIRMED' ? 3 : 1;
  return (
    <ol className="progress" aria-label="Order progress">
      {steps.map((s, i) => {
        let cls = '';
        if (status === 'CANCELLED' && i === 1) cls = 'failed';
        else if (i < done) cls = 'done';
        else if (i === done) cls = 'active';
        return <li key={s} className={cls}>{s}</li>;
      })}
    </ol>
  );
}

function Orders({ onBack }) {
  const [orders, setOrders] = useState(null);
  const load = useCallback(() => api('/orders').then(setOrders).catch(() => setOrders([])), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!orders?.some((o) => o.status === 'PENDING')) return undefined;
    const t = setInterval(load, 2000); // the stock check finishes asynchronously via Kafka
    return () => clearInterval(t);
  }, [orders, load]);

  return (
    <section className="page narrow">
      <div className="page-head">
        <h1 className="page-title">Your orders</h1>
        <button className="btn btn-quiet" onClick={onBack}>Back to shop</button>
      </div>
      {orders === null && <p className="hint">Loading your orders…</p>}
      {orders?.length === 0 && (
        <div className="empty"><p>You haven't placed an order yet.</p><button className="btn btn-primary" onClick={onBack}>Start shopping</button></div>
      )}
      {orders?.map((o) => (
        <article className="order" key={o.id}>
          <header className="order-head">
            <h2>Order {o.id.slice(0, 8)}</h2>
            <time className="hint" dateTime={o.createdAt}>{new Date(o.createdAt).toLocaleString()}</time>
          </header>
          <Progress status={o.status} />
          {o.failureReason && <p className="error">{o.failureReason}</p>}
          <ul className="order-items">
            {o.items.map((i) => <li key={i.productId}><span>{i.qty} × {i.name}</span><span>{money(i.price * i.qty)}</span></li>)}
          </ul>
          <footer className="order-foot">
            <span className="hint">{o.shippingAddress}</span>
            <strong>{money(o.total)}</strong>
          </footer>
        </article>
      ))}
    </section>
  );
}

/* ───────── admin ───────── */
function Admin({ onBack, notify }) {
  const [f, setF] = useState({
    name: '', category: '', price: '', stock: '',
    image: '📦', description: '', attributes: '{\n  "brand": ""\n}'
  });
  const [imageFile, setImageFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  function chooseImage(e) {
    const file = e.target.files?.[0] || null;
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      notify('Choose a JPEG, PNG, or WebP image.', 'error');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      notify('Image must be 5 MB or smaller.', 'error');
      e.target.value = '';
      return;
    }

    setImageFile(file);
    setPreview((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (saving) return;

    let attributes;
    try {
      attributes = JSON.parse(f.attributes || '{}');
    } catch {
      notify('Attributes must be valid JSON.', 'error');
      return;
    }

    setSaving(true);
    try {
      let image = f.image;
      if (imageFile) {
        const uploaded = await uploadImage(imageFile);
        image = uploaded.image;
      }

      await api('/products', {
        method: 'POST',
        body: { ...f, image, attributes },
      });

      notify(`Added ${f.name}`);
      setF({
        name: '', category: '', price: '', stock: '',
        image: '📦', description: '', attributes: '{\n  "brand": ""\n}'
      });
      setImageFile(null);
      setPreview((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return '';
      });
      const picker = document.getElementById('product-image-file');
      if (picker) picker.value = '';
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page narrow">
      <div className="page-head">
        <h1 className="page-title">Add a product</h1>
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back to shop
        </button>
      </div>
      <form className="stack admin" onSubmit={submit}>
        <input aria-label="Name" placeholder="Name" value={f.name} onChange={set('name')} required />
        <input aria-label="Category" placeholder="Category, for example Electronics" value={f.category} onChange={set('category')} required />
        <div className="two">
          <input aria-label="Price" placeholder="Price in ₹" type="number" min="0" step="0.01" value={f.price} onChange={set('price')} required />
          <input aria-label="Stock" placeholder="Units in stock" type="number" min="0" value={f.stock} onChange={set('stock')} required />
        </div>

        <label htmlFor="product-image-file">Product image (JPEG, PNG, or WebP; max 5 MB)</label>
        <input
          id="product-image-file"
          aria-label="Product image file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={chooseImage}
        />
        {preview && (
          <div className="product-image-preview">
            <img
              src={preview}
              alt="Selected product preview"
              style={{ width: '100%', maxWidth: 240, maxHeight: 220, objectFit: 'contain', borderRadius: 8 }}
            />
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setImageFile(null);
                setPreview((previous) => {
                  if (previous) URL.revokeObjectURL(previous);
                  return '';
                });
                const picker = document.getElementById('product-image-file');
                if (picker) picker.value = '';
              }}
            >
              Remove selected image
            </button>
          </div>
        )}

        <textarea aria-label="Description" placeholder="Description" value={f.description} onChange={set('description')} rows={2} />
        <label className="hint" htmlFor="attrs">Attributes: any JSON object, different for each product type</label>
        <textarea id="attrs" value={f.attributes} onChange={set('attributes')} rows={6} className="mono" />
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? 'Uploading and saving…' : 'Add product'}
        </button>
      </form>
    </section>
  );
}

/* ───────── storefront ───────── */
function Hero({ categories, onPick }) {
  return (
    <section className="hero">
      <div className="hero-copy">
        <h1>Gear for your desk, your trail and your kitchen.</h1>
        <p>Pick a department or search for something specific. Everything you add is checked against live stock when you order.</p>
      </div>
      <div className="blocks">
        {categories.map((c, i) => {
          const t = themeFor(c.name);
          return (
            <button key={c.name} className="block" style={{ '--i': i, background: t.solid, color: t.on }} onClick={() => onPick(c.name)}>
              <span className="block-icon" aria-hidden="true">{t.icon}</span>
              <span className="block-name">{c.name}</span>
              <span className="block-count">{c.count} {c.count === 1 ? 'product' : 'products'}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Tile({ p, onOpen, onAdd }) {
  const t = themeFor(p.category);
  const low = p.stock > 0 && p.stock <= 10;
  const brand = p.attributes?.brand;
  const description = p.description?.trim();

  return (
    <article className="tile">
      <div className="tile-art" style={{ background: t.tint }}>
        <button className="tile-open" aria-label={`View ${p.name}`} onClick={() => onOpen(p)}>
          <Visual image={p.image} name={p.name} />
        </button>
        <button className="tile-add" aria-label={`Add ${p.name} to cart`}
          disabled={p.stock < 1} onClick={() => onAdd(p)}>
          +
        </button>
      </div>

      <div className="tile-body">
        <span className="tile-category">{p.category}</span>
        <h3>
          <button className="tile-title" onClick={() => onOpen(p)}>
            {p.name}
          </button>
        </h3>

        {brand && <p className="tile-brand">Brand: {brand}</p>}
        {description && <p className="tile-description">{description}</p>}

        <p className="tile-row">
          <span className="price">{money(p.price)}</span>
        </p>

        <p className="tile-availability">
          {p.stock < 1 ? (
            <span className="stock out">Out of stock</span>
          ) : low ? (
            <span className="stock low">Only {p.stock} left</span>
          ) : (
            <span className="stock">In stock</span>
          )}
        </p>
      </div>
    </article>
  );
}

export default function App() {
  const [view, setView] = useState('shop');
  const [user, setUser] = useState(null);
  const [products, setProducts] = useState({ items: [], total: 0, pages: 1, page: 1 });
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({ q: '', category: '', sort: '', page: 1 });
  const [cart, setCart] = useState({ items: [], count: 0, total: 0 });
  const [showAuth, setShowAuth] = useState(false);
  const [showCart, setShowCart] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef();

  const notify = useCallback((text, kind = 'ok') => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const loadCart = useCallback(() => api('/cart').then(setCart).catch(() => {}), []);

  useEffect(() => {
    if (!getToken()) return;
    api('/users/me').then((u) => { setUser(u); loadCart(); }).catch(() => setToken(null));
  }, [loadCart]);

  useEffect(() => {
    const order = Object.keys(THEMES);
    const rank = (n) => (order.includes(n) ? order.indexOf(n) : order.length);
    api('/products/categories', { auth: false })
      .then((cs) => setCategories([...cs].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ page: filters.page, limit: 8 });
      ['q', 'category', 'sort'].forEach((k) => filters[k] && qs.set(k, filters[k]));
      api(`/products?${qs}`, { auth: false }).then(setProducts).catch((e) => notify(e.message, 'error'));
    }, 200);
    return () => clearTimeout(t);
  }, [filters, notify]);

  const filtered = Boolean(filters.q || filters.category);
  const clearFilters = () => setFilters({ q: '', category: '', sort: filters.sort, page: 1 });
  const pickCategory = (name) => { setFilters({ ...filters, category: name, q: '', page: 1 }); window.scrollTo({ top: 0 }); };
  const requireLogin = () => { if (!user) { setShowAuth(true); return false; } return true; };

  async function addToCart(p) {
    if (!requireLogin()) return;
    try {
      setCart(await api('/cart/items', { method: 'POST', body: { productId: p.id, qty: 1 } }));
      notify(`Added ${p.name} to your cart`);
      setSelected(null);
    } catch (e) { notify(e.message, 'error'); }
  }
  async function setQty(id, qty) {
    try { setCart(await api(`/cart/items/${id}`, { method: 'PUT', body: { qty } })); } catch (e) { notify(e.message, 'error'); }
  }
  async function checkout(shippingAddress) {
    setBusy(true);
    try {
      await api('/orders', { method: 'POST', body: { shippingAddress } });
      setCart({ items: [], count: 0, total: 0 });
      setShowCart(false); setView('orders'); notify('Order placed');
    } catch (e) { notify(e.message, 'error'); } finally { setBusy(false); }
  }
  function logout() { setToken(null); setUser(null); setCart({ items: [], count: 0, total: 0 }); setView('shop'); }
  function onAuthed(u) { setUser(u); setShowAuth(false); loadCart(); notify(`Welcome, ${u.name.split(' ')[0]}`); }

  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <button className="logo" onClick={() => { setView('shop'); clearFilters(); }} aria-label="Kart home">kart<i /></button>
          <input className="search" type="search" aria-label="Search products" placeholder="Search products"
            value={filters.q} onChange={(e) => { setView('shop'); setFilters({ ...filters, q: e.target.value, page: 1 }); }} />
          <nav aria-label="Account">
            {user?.role === 'admin' && <button className="btn btn-quiet" onClick={() => setView('admin')}>Admin</button>}
            {user && <button className="btn btn-quiet" onClick={() => setView('orders')}>Orders</button>}
            <button className="btn btn-ink cart-btn" onClick={() => (requireLogin() ? setShowCart(true) : null)}>
              Cart <span className="bubble" aria-label={`${cart.count} items`}>{cart.count}</span>
            </button>
            {user ? <button className="btn btn-quiet" onClick={logout}>Log out</button> : <button className="btn btn-primary" onClick={() => setShowAuth(true)}>Log in</button>}
          </nav>
        </div>
      </header>

      {/* KART_MARKET_NAV */}
      <nav className="market-nav" aria-label="Shop departments">
        <div className="market-nav-in">
          <button onClick={() => { setView('shop'); clearFilters(); }}>
            ☰ All
          </button>
          {categories.slice(0, 8).map((c) => (
            <button key={c.name}
              onClick={() => { setView('shop'); pickCategory(c.name); }}>
              {c.name}
            </button>
          ))}
          <span className="market-nav-promo">Discover something great</span>
        </div>
      </nav>

      <main>
        {view === 'orders' && <Orders onBack={() => setView('shop')} />}
        {view === 'admin' && <Admin onBack={() => setView('shop')} notify={notify} />}
        {view === 'shop' && (
          <div className="page">
            {!filtered && <Hero categories={categories} onPick={pickCategory} />}

            <div className="shelf-head">
              <h2 className="shelf-title">
                {filters.q ? `Results for “${filters.q}”` : filters.category || 'All products'}
              </h2>
              <div className="shelf-tools">
                <span className="hint">{products.total} {products.total === 1 ? 'product' : 'products'}</span>
                {filtered && <button className="btn btn-quiet" onClick={clearFilters}>Clear filters</button>}
                <label className="sort">
                  <span className="sr">Sort by</span>
                  <select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value, page: 1 })}>
                    <option value="">Name</option><option value="price_asc">Price, low to high</option>
                    <option value="price_desc">Price, high to low</option><option value="newest">Newest</option>
                  </select>
                </label>
              </div>
            </div>

            {filtered && categories.length > 0 && (
              <div className="chips" role="group" aria-label="Departments">
                <button className={!filters.category ? 'chip on' : 'chip'} onClick={() => setFilters({ ...filters, category: '', page: 1 })}>All</button>
                {categories.map((c) => (
                  <button key={c.name} className={filters.category === c.name ? 'chip on' : 'chip'}
                    onClick={() => setFilters({ ...filters, category: c.name, page: 1 })}>
                    <i style={{ background: themeFor(c.name).solid }} />{c.name}
                  </button>
                ))}
              </div>
            )}

            {products.items.length === 0 ? (
              <div className="empty">
                <p>Nothing matches your search. Try a different word or clear the filters.</p>
                <button className="btn btn-primary" onClick={clearFilters}>Clear filters</button>
              </div>
            ) : (
              <div className="grid">
                {products.items.map((p) => <Tile key={p.id} p={p} onOpen={setSelected} onAdd={addToCart} />)}
              </div>
            )}

            {products.pages > 1 && (
              <nav className="pager" aria-label="Pages">
                <button className="btn btn-quiet" disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>Previous</button>
                <span className="hint">Page {products.page} of {products.pages}</span>
                <button className="btn btn-quiet" disabled={filters.page >= products.pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>Next</button>
              </nav>
            )}
          </div>
        )}
      </main>

      {showAuth && <AuthDialog onClose={() => setShowAuth(false)} onAuthed={onAuthed} />}
      {selected && <ProductDialog product={selected} onClose={() => setSelected(null)} onAdd={addToCart} />}
      {showCart && (
        <CartDrawer cart={cart} loggedIn={!!user} busy={busy} onClose={() => setShowCart(false)}
          onQty={setQty} onCheckout={checkout} onLogin={() => { setShowCart(false); setShowAuth(true); }} />
      )}
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </>
  );
}
