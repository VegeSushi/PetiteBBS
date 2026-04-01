const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt'); 

function startWebServer(pool) {
    const app = express();

    app.use(express.urlencoded({ extended: true }));
    app.use(session({
        secret: process.env.SESSION_SECRET || 'fallback_secret',
        resave: false,
        saveUninitialized: false
    }));

    // --- SYSTEM KILLSWITCH MIDDLEWARE ---
    app.use((req, res, next) => {
        if (!global.webPanelActive) {
            return res.status(503).send(`
                <div style="font-family: sans-serif; text-align: center; margin-top: 100px;">
                    <h2 style="color: red;">System Offline</h2>
                    <p>The Web Portal is currently disabled by the System Operator.</p>
                </div>
            `);
        }
        next();
    });

    // --- GUARDS ---
    const requireAuth = (req, res, next) => {
        if (req.session.user && req.session.user.privilege_level >= 2) return next();
        res.redirect('/login');
    };

    const requireBoards = (req, res, next) => {
        if (req.session.user && req.session.user.privilege_level >= 3) return next();
        res.status(403).send('<div style="font-family: sans-serif; text-align: center; margin-top: 50px;"><h3>Access Denied</h3><p>You need at least Level 3 to create boards.</p><a href="/">Go Back</a></div>');
    };

    const requireAdmin = (req, res, next) => {
        if (req.session.user && req.session.user.privilege_level >= 5) return next();
        res.status(403).send('<div style="font-family: sans-serif; text-align: center; margin-top: 50px;"><h3>Access Denied</h3><p>You need Admin (Level 5) privileges to view this page.</p><a href="/">Go Back</a></div>');
    };

    // --- UI ---
    const renderUI = (user, title, content) => {
        let nav = `
            <div style="display: flex; gap: 20px; background: #eee; padding: 15px; border-radius: 5px; margin-bottom: 20px; align-items: center;">
                <strong>Web Portal (Level ${user.privilege_level})</strong>
                <a href="/" style="text-decoration: none; color: #333;">Dashboard</a>`;
        
        if (user.privilege_level >= 3) {
            nav += `<a href="/boards" style="text-decoration: none; color: #333;">My Boards</a>`;
        }

        if (user.privilege_level >= 5) {
            nav += `<a href="/users" style="text-decoration: none; color: #333;">User Management</a>`;
        }

        nav += `
                <form method="POST" action="/logout" style="margin: 0; margin-left: auto;">
                    <button type="submit" style="background: none; border: none; color: red; cursor: pointer; font-weight: bold;">Logout (${user.handle})</button>
                </form>
            </div>`;

        return `
            <div style="font-family: sans-serif; max-width: 900px; margin: 20px auto;">
                ${nav}
                <h2>${title}</h2>
                ${content}
            </div>
        `;
    };

    // --- ROUTES ---
    app.get('/login', (req, res) => {
        res.send(`
            <div style="font-family: sans-serif; max-width: 300px; margin: 50px auto;">
                <h2>Web Portal Login</h2>
                <form method="POST" action="/login">
                    <input type="text" name="id" placeholder="User ID" required style="width: 100%; padding: 8px; margin-bottom: 10px; box-sizing: border-box;">
                    <input type="password" name="password" placeholder="Password" required style="width: 100%; padding: 8px; margin-bottom: 10px; box-sizing: border-box;">
                    <button type="submit" style="width: 100%; padding: 8px; background: #007bff; color: white; border: none; cursor: pointer;">Login</button>
                </form>
            </div>
        `);
    });

    app.post('/login', async (req, res) => {
        let conn;
        try {
            conn = await pool.getConnection();
            const users = await conn.query("SELECT * FROM users WHERE id = ?", [req.body.id]);
            
            if (users.length > 0) {
                const match = await bcrypt.compare(req.body.password, users[0].password_hash);
                if (match) {
                    const user = users[0];
                    if (user.privilege_level < 2) {
                        return res.send('<div style="font-family: sans-serif; text-align: center; margin-top: 50px;">Access Denied. Your account is Level 1 (View Only). <br><br><a href="/login">Go back</a></div>');
                    }
                    req.session.user = { id: user.id, handle: user.handle, privilege_level: user.privilege_level };
                    return res.redirect('/');
                }
            }
            res.send('<div style="font-family: sans-serif; text-align: center; margin-top: 50px;">Invalid ID or Password. <a href="/login">Try again</a></div>');
        } catch (err) {
            res.status(500).send("Database error");
        } finally {
            if (conn) conn.release();
        }
    });

    app.get('/', requireAuth, async (req, res) => {
        let text = `<p>Welcome back, ${req.session.user.handle}!</p>`;
        if (req.session.user.privilege_level === 2) text += `<p>You have Level 2 access. You can post on the BBS, but cannot create your own boards.</p>`;
        if (req.session.user.privilege_level >= 3) text += `<p>Use the navigation menu to manage your boards.</p>`;
        
        res.send(renderUI(req.session.user, 'Dashboard', text));
    });

    app.get('/boards', requireBoards, async (req, res) => {
        let conn;
        try {
            conn = await pool.getConnection();
            const myBoards = await conn.query("SELECT * FROM boards WHERE created_by = ?", [req.session.user.id]);
            
            let html = `<h3>Your Boards</h3>`;
            if (myBoards.length === 0) {
                html += `<p>You haven't created any boards yet.</p>`;
            } else {
                html += `<ul style="line-height: 1.6;">`;
                myBoards.forEach(b => { html += `<li><strong>p/${b.title}</strong> (Created: ${new Date(b.created_at).toLocaleString()})</li>`; });
                html += `</ul>`;
            }

            html += `<hr style="margin: 20px 0; border: 1px solid #ddd;">`;

            if (req.session.user.privilege_level === 3 && myBoards.length >= 1) {
                html += `<p style="color: red; font-weight: bold;">You have reached your limit of 1 board (Level 3 restriction).</p>`;
            } else {
                html += `
                    <h3>Create a New Board</h3>
                    <form method="POST" action="/boards/create" style="display: flex; gap: 10px;">
                        <input type="text" name="title" placeholder="Board Title (letters/numbers only)" required pattern="[A-Za-z0-9]+" title="Letters and numbers only, no spaces" style="padding: 8px; width: 250px;">
                        <button type="submit" style="background: #28a745; color: white; border: none; padding: 8px 15px; cursor: pointer;">Create Board</button>
                    </form>
                    <p style="font-size: 0.9em; color: #666;">Users will access this via <strong>p/your_title</strong> in the BBS.</p>
                `;
            }
            res.send(renderUI(req.session.user, 'Board Management', html));
        } catch (err) {
            res.status(500).send("Database error");
        } finally {
            if (conn) conn.release();
        }
    });

    app.post('/boards/create', requireBoards, async (req, res) => {
        let conn;
        try {
            conn = await pool.getConnection();
            
            if (req.session.user.privilege_level === 3) {
                const countRes = await conn.query("SELECT COUNT(*) as count FROM boards WHERE created_by = ?", [req.session.user.id]);
                if (Number(countRes[0].count) >= 1) return res.status(403).send('<div style="font-family: sans-serif; text-align: center; margin-top: 50px;">Quota exceeded.<br><br><a href="/boards">Go back</a></div>');
            }

            const title = req.body.title.trim();
            const alphanumericRegex = /^[A-Za-z0-9]+$/;
            if (!alphanumericRegex.test(title)) {
                return res.status(400).send('<div style="font-family: sans-serif; text-align: center; margin-top: 50px;">Invalid Board Title. Only letters and numbers are allowed.<br><br><a href="/boards">Go back</a></div>');
            }

            if (title) await conn.query("INSERT IGNORE INTO boards (title, created_by) VALUES (?, ?)", [title, req.session.user.id]);
            res.redirect('/boards');
        } catch (err) {
            res.status(500).send("Database error.");
        } finally {
            if (conn) conn.release();
        }
    });

    app.get('/users', requireAdmin, async (req, res) => {
        let conn;
        try {
            conn = await pool.getConnection();
            const users = await conn.query("SELECT id, handle, email, privilege_level FROM users ORDER BY id ASC");
            let table = `<table border="1" style="width: 100%; border-collapse: collapse; text-align: left;"><tr style="background-color: #f2f2f2;"><th style="padding: 8px;">ID</th><th style="padding: 8px;">Handle</th><th style="padding: 8px;">Email</th><th style="padding: 8px;">Privilege</th><th style="padding: 8px;">Change Level</th></tr>`;
            users.forEach(u => {
                table += `<tr><td style="padding: 8px;">${u.id}</td><td style="padding: 8px;">${u.handle}</td><td style="padding: 8px;">${u.email}</td><td style="padding: 8px; text-align: center;"><strong>${u.privilege_level}</strong></td><td style="padding: 8px;">
                        <form method="POST" action="/update-privilege/${u.id}" style="margin:0; display:flex; gap: 5px;">
                            <select name="new_level" style="padding: 5px;">
                                <option value="1" ${u.privilege_level === 1 ? 'selected' : ''}>1 - View Only</option>
                                <option value="2" ${u.privilege_level === 2 ? 'selected' : ''}>2 - Post Only</option>
                                <option value="3" ${u.privilege_level === 3 ? 'selected' : ''}>3 - 1 Board</option>
                                <option value="4" ${u.privilege_level === 4 ? 'selected' : ''}>4 - Infinite Boards</option>
                                <option value="5" ${u.privilege_level === 5 ? 'selected' : ''}>5 - Everything (Admin)</option>
                            </select>
                            <button type="submit" style="background: #28a745; color: white; border: none; padding: 5px 10px; cursor: pointer;">Update</button>
                        </form></td></tr>`;
            });
            table += `</table>`;
            res.send(renderUI(req.session.user, 'User Management', table));
        } catch (err) {
            res.status(500).send("Database error");
        } finally {
            if (conn) conn.release();
        }
    });

    app.post('/update-privilege/:id', requireAdmin, async (req, res) => {
        let conn;
        try {
            conn = await pool.getConnection();
            const newLevel = parseInt(req.body.new_level, 10);
            if (newLevel >= 1 && newLevel <= 5) await conn.query("UPDATE users SET privilege_level = ? WHERE id = ?", [newLevel, req.params.id]);
            res.redirect('/users');
        } catch (err) {
            res.status(500).send("Database error");
        } finally {
            if (conn) conn.release();
        }
    });

    app.post('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

    const port = process.env.WEB_PORT || 3000;
    app.listen(port, () => { console.log(`Web Portal is live at http://localhost:${port}`); });
}

module.exports = { startWebServer };