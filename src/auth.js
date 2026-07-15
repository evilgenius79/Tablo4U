// @ts-check
/**
 * @file Minimal multi-user store with scrypt-hashed passwords (Node built-in
 * crypto — no native deps). Users persist to data/users.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { baseDir } = require('./paths');

const DATA_DIR = path.join(baseDir(), 'data');

const USERS_FILE = path.join(DATA_DIR, 'users.json');

/**
 * @typedef {Object} User
 * @property {string} username
 * @property {string} salt
 * @property {string} hash
 * @property {'admin'|'user'} role
 * @property {string} createdAt
 */

/** @returns {User[]} */
function load() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

/** @param {User[]} users */
function save(users) {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

/**
 * @param {string} password
 * @param {string} salt
 * @returns {string} hex hash
 */
function hashPw(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} constant-time compare
 */
function safeEq(a, b) {
    const ab = Buffer.from(a);

    const bb = Buffer.from(b);

    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const Auth = {
    /**
     * Ensures at least one admin exists. If none, creates `admin` with the
     * given password (or a random one, returned so the caller can print it).
     *
     * @param {string} [adminPassword]
     * @returns {{created:boolean, username?:string, password?:string}}
     */
    ensureAdmin(adminPassword) {
        const users = load();

        if (users.some(u => u.role === 'admin')) {
            return { created: false };
        }

        const password = adminPassword || crypto.randomBytes(6).toString('base64url');

        Auth.addUser('admin', password, 'admin');

        return { created: true, username: 'admin', password };
    },

    /**
     * @param {string} username
     * @param {string} password
     * @param {'admin'|'user'} [role]
     * @returns {User}
     */
    addUser(username, password, role = 'user') {
        username = String(username || '').trim().toLowerCase();

        if (!username || !password || typeof password !== 'string') {
            throw new Error('username and password required');
        }

        const users = load();

        if (users.some(u => u.username === username)) {
            throw new Error('user already exists');
        }

        const salt = crypto.randomBytes(16).toString('hex');

        /** @type {User} */
        const user = { username, salt, hash: hashPw(password, salt), role, createdAt: new Date().toISOString() };

        users.push(user);

        save(users);

        return user;
    },

    /**
     * Resets a user's password (used to keep admin in sync with ADMIN_PASSWORD).
     *
     * @param {string} username
     * @param {string} password
     * @returns {boolean} whether the user existed
     */
    setPassword(username, password) {
        const users = load();

        const u = users.find(x => x.username === String(username || '').trim().toLowerCase());

        if (!u) return false;

        u.salt = crypto.randomBytes(16).toString('hex');

        u.hash = hashPw(password, u.salt);

        save(users);

        return true;
    },

    /**
     * @param {string} username
     * @param {string} password
     * @returns {User|null}
     */
    verify(username, password) {
        username = String(username || '').trim().toLowerCase();

        // Non-string/missing passwords would make scryptSync throw (a 500 on
        // /api/login) — treat them as plain bad credentials instead.
        if (typeof password !== 'string' || !password) {
            return null;
        }

        const user = load().find(u => u.username === username);

        if (!user) {
            return null;
        }

        return safeEq(user.hash, hashPw(password, user.salt)) ? user : null;
    },

    /** @returns {{username:string, role:string, createdAt:string}[]} */
    list() {
        return load().map(u => ({ username: u.username, role: u.role, createdAt: u.createdAt }));
    },

    /** @param {string} username */
    remove(username) {
        username = String(username || '').trim().toLowerCase();

        const users = load();

        const kept = users.filter(u => u.username !== username);

        // never delete the last admin
        if (!kept.some(u => u.role === 'admin')) {
            throw new Error('cannot remove the last admin');
        }

        save(kept);
    },

    /**
     * Per-user favorites + recently watched (safe subset).
     *
     * @param {string} username
     * @returns {{favorites: string[], recent: {id:string, at:number}[]}}
     */
    getProfile(username) {
        const u = load().find(x => x.username === String(username || '').trim().toLowerCase());

        return { favorites: (u && u.favorites) || [], recent: (u && u.recent) || [] };
    },

    /**
     * Add or remove a favorite channel for a user.
     *
     * @param {string} username
     * @param {string} channelId
     * @param {boolean} on
     */
    setFavorite(username, channelId, on) {
        const users = load();

        const u = users.find(x => x.username === String(username || '').trim().toLowerCase());

        if (!u) return;

        u.favorites = u.favorites || [];

        const i = u.favorites.indexOf(channelId);

        if (on && i < 0) u.favorites.push(channelId);

        if (!on && i >= 0) u.favorites.splice(i, 1);

        save(users);
    },

    /**
     * Record a channel as recently watched (most-recent first, capped at 20).
     *
     * @param {string} username
     * @param {string} channelId
     */
    addRecent(username, channelId) {
        const users = load();

        const u = users.find(x => x.username === String(username || '').trim().toLowerCase());

        if (!u) return;

        u.recent = (u.recent || []).filter(r => r.id !== channelId);

        u.recent.unshift({ id: channelId, at: Date.now() });

        u.recent = u.recent.slice(0, 20);

        save(users);
    }
};

module.exports = Auth;
