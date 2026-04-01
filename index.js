require('dotenv').config();
const net = require('net');
const mariadb = require('mariadb');
const bcrypt = require('bcrypt');

// Set global state for the Web Panel killswitch
global.webPanelActive = true;

const { send, fromPetscii } = require('./scripts/print');
const { startWebServer } = require('./scripts/web');
const { displayBoards, handleBoardInput } = require('./scripts/boards');
const { displayPosts, handlePostInput, displayReadPostChunk } = require('./scripts/posts');

const pool = mariadb.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 5
});

async function initializeDefaultUser() {
    let conn;
    try {
        conn = await pool.getConnection();
        const existingAdmins = await conn.query("SELECT id FROM users WHERE privilege_level >= 5 LIMIT 1");
        if (existingAdmins.length === 0) {
            const handle = process.env.DEFAULT_ADMIN_HANDLE || 'admin';
            const hash = await bcrypt.hash(process.env.DEFAULT_ADMIN_PASS || 'admin123', 10);
            await conn.query("INSERT INTO users (handle, name, country, email, phone, password_hash, privilege_level) VALUES (?, 'System Operator', 'N/A', ?, 'N/A', ?, 5)", [handle, process.env.DEFAULT_ADMIN_EMAIL || 'admin@localhost', hash]);
            console.log(`[SUCCESS] Created initial user: Handle='${handle}' (Level 5)`);
        }
    } catch (err) {
        console.error("Initialization error:", err);
    } finally {
        if (conn) conn.release();
    }
}

const server = net.createServer((socket) => {
    socket.config = { rows: 25, cols: 40, charset: 'ascii', color: 'color', lf: 'crlf' };
    let state = 'INIT_ROWS';
    let regData = {};
    let loginData = {};
    
    // Variables for line buffering (C64 fix)
    socket.inputBuffer = '';
    socket.lastCharCode = 0;

    const prompt = () => {
        switch(state) {
            case 'INIT_ROWS': send(socket, "Enter ROW size (Default 25): "); break;
            case 'INIT_COLS': send(socket, "Enter COLUMN size (Default 40): "); break;
            case 'INIT_CHARSET': send(socket, "ASCII or PETSCII? (Default ASCII): "); break;
            case 'INIT_LF': send(socket, "Linefeed? (CR, LF, CRLF) (Default CRLF): "); break;
            case 'INIT_COLOR': send(socket, "MONO or COLOR? (Default COLOR): "); break;
            case 'MAIN_MENU':
                send(socket, "\n<cyan>=== WELCOME TO THE BBS ===</cyan>\n[1] Register\n[2] Login\n[3] Guest Login\n\nChoice: ");
                break;
            case 'REG_HANDLE': send(socket, "Handle (required): "); break;
            case 'REG_NAME': send(socket, "Name (optional): "); break;
            case 'REG_COUNTRY': send(socket, "Country (optional): "); break;
            case 'REG_EMAIL': send(socket, "E-Mail (required): "); break;
            case 'REG_PHONE': send(socket, "Phone number (optional): "); break;
            case 'REG_PASS': send(socket, "Password (required): "); break;
            case 'REG_PASS_VERIFY': send(socket, "Verify password (required): "); break;
            case 'LOGIN_ID': send(socket, "Enter User ID: "); break;
            case 'LOGIN_PASS': send(socket, "Enter Password: "); break;
            case 'LOGGED_IN': 
                let cmds = "<yellow>/boards</yellow>, <yellow>/dms</yellow>, <yellow>/quit</yellow>";
                if (socket.user.privilege_level >= 5) {
                    cmds += "\n<cyan>SysOp Tools:</cyan> /users, /setlevel [id] [1-5], /webpanel [on/off]";
                }
                send(socket, `\n<green>Logged in!</green> Commands: ${cmds}\nCommand: `); 
                break;
        }
    };

    const processCommand = async (input, trimmed) => {
        try {
            switch(state) {
                case 'INIT_ROWS': if (trimmed) socket.config.rows = parseInt(trimmed) || 25; state = 'INIT_COLS'; prompt(); break;
                case 'INIT_COLS': if (trimmed) socket.config.cols = parseInt(trimmed) || 40; state = 'INIT_CHARSET'; prompt(); break;
                case 'INIT_CHARSET': if (trimmed.toLowerCase() === 'petscii') socket.config.charset = 'petscii'; state = 'INIT_LF'; prompt(); break;
                case 'INIT_LF': 
                    const lfInput = trimmed.toLowerCase();
                    if (lfInput === 'cr' || lfInput === 'lf') socket.config.lf = lfInput;
                    else socket.config.lf = 'crlf';
                    state = 'INIT_COLOR'; prompt(); break;
                case 'INIT_COLOR': if (trimmed.toLowerCase() === 'mono') socket.config.color = 'mono'; state = 'MAIN_MENU'; prompt(); break;
                
                case 'MAIN_MENU':
                    if (trimmed === '1') { state = 'REG_HANDLE'; prompt(); }
                    else if (trimmed === '2') { state = 'LOGIN_ID'; prompt(); }
                    else if (trimmed === '3') { socket.user = { id: 0, privilege_level: 0, handle: 'Guest' }; state = 'LOGGED_IN'; prompt(); }
                    else { prompt(); }
                    break;
                
                // Registration
                case 'REG_HANDLE': if (!trimmed) return prompt(); regData.handle = trimmed; state = 'REG_NAME'; prompt(); break;
                case 'REG_NAME': regData.name = trimmed; state = 'REG_COUNTRY'; prompt(); break;
                case 'REG_COUNTRY': regData.country = trimmed; state = 'REG_EMAIL'; prompt(); break;
                case 'REG_EMAIL': if (!trimmed) return prompt(); regData.email = trimmed; state = 'REG_PHONE'; prompt(); break;
                case 'REG_PHONE': regData.phone = trimmed; state = 'REG_PASS'; prompt(); break;
                case 'REG_PASS': if (!trimmed) return prompt(); regData.password = trimmed; state = 'REG_PASS_VERIFY'; prompt(); break;
                case 'REG_PASS_VERIFY':
                    if (trimmed !== regData.password) { send(socket, "\n<red>Passwords mismatch.</red>\n"); state = 'REG_PASS'; return prompt(); }
                    const hash = await bcrypt.hash(regData.password, 10);
                    let regConn;
                    try {
                        regConn = await pool.getConnection();
                        const res = await regConn.query("INSERT INTO users (handle, name, country, email, phone, password_hash, privilege_level) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id", [regData.handle, regData.name, regData.country, regData.email, regData.phone, hash]);
                        send(socket, `\n<green>Registered! ID: ${res[0].id}.</green>\n`);
                        state = 'MAIN_MENU'; prompt();
                    } catch (err) { send(socket, `\n<red>Registration failed.</red>\n`); state = 'MAIN_MENU'; prompt(); } finally { if (regConn) regConn.release(); }
                    break;

                // Login
                case 'LOGIN_ID': if (!trimmed) return prompt(); loginData.id = trimmed; state = 'LOGIN_PASS'; prompt(); break;
                case 'LOGIN_PASS':
                    let loginConn;
                    try {
                        loginConn = await pool.getConnection();
                        const rows = await loginConn.query("SELECT * FROM users WHERE id = ?", [loginData.id]);
                        if (rows.length > 0 && await bcrypt.compare(trimmed, rows[0].password_hash)) {
                            socket.user = rows[0];
                            send(socket, `\n<cyan>Welcome, ${socket.user.handle} (Level ${socket.user.privilege_level})!</cyan>`);
                            state = 'LOGGED_IN'; prompt();
                        } else { send(socket, "\n<red>Invalid ID or Password.</red>\n"); state = 'MAIN_MENU'; prompt(); }
                    } catch (err) { send(socket, `\n<red>Login error.</red>\n`); state = 'MAIN_MENU'; prompt(); } finally { if (loginConn) loginConn.release(); }
                    break;

                // Root Menu & Admin Tools
                case 'LOGGED_IN':
                    if (trimmed === '/quit') { 
                        send(socket, "\n<yellow>Goodbye!</yellow>\n"); socket.end(); 
                    } 
                    else if (trimmed === '/boards') { 
                        state = 'LIST_BOARDS'; await displayBoards(socket, pool); 
                    }
                    else if (trimmed === '/dms') { 
                        send(socket, "\n<yellow>Direct Messages coming soon...</yellow>"); prompt(); 
                    }
                    else if (trimmed === '/users' && socket.user.privilege_level >= 5) {
                        let uConn;
                        try {
                            uConn = await pool.getConnection();
                            const users = await uConn.query("SELECT id, handle, privilege_level FROM users ORDER BY id ASC");
                            send(socket, "\n<cyan>--- USER LIST ---</cyan>");
                            users.forEach(u => send(socket, `[ID: ${u.id}] ${u.handle} (Level ${u.privilege_level})`));
                            send(socket, "-".repeat(socket.config.cols));
                        } catch (err) { send(socket, "\n<red>Database error.</red>"); } finally { if (uConn) uConn.release(); }
                        prompt();
                    }
                    else if (trimmed.startsWith('/setlevel ') && socket.user.privilege_level >= 5) {
                        const parts = trimmed.split(' ');
                        if (parts.length === 3) {
                            const targetId = parseInt(parts[1]);
                            const newLevel = parseInt(parts[2]);
                            if (!isNaN(targetId) && !isNaN(newLevel) && newLevel >= 1 && newLevel <= 5) {
                                let slConn;
                                try {
                                    slConn = await pool.getConnection();
                                    await slConn.query("UPDATE users SET privilege_level = ? WHERE id = ?", [newLevel, targetId]);
                                    send(socket, `\n<green>Success: User ID ${targetId} is now Level ${newLevel}.</green>`);
                                } catch (err) { send(socket, "\n<red>Database error.</red>"); } finally { if (slConn) slConn.release(); }
                            } else { send(socket, `\n<red>Usage: /setlevel [user_id] [1-5]</red>`); }
                        } else { send(socket, `\n<red>Usage: /setlevel [user_id] [1-5]</red>`); }
                        prompt();
                    }
                    else if (trimmed.startsWith('/webpanel ') && socket.user.privilege_level >= 5) {
                        const action = trimmed.split(' ')[1]?.toLowerCase();
                        if (action === 'on') {
                            global.webPanelActive = true;
                            send(socket, `\n<green>Web Panel is now ONLINE.</green>`);
                        } else if (action === 'off') {
                            global.webPanelActive = false;
                            send(socket, `\n<yellow>Web Panel is now OFFLINE.</yellow>`);
                        } else { send(socket, `\n<red>Usage: /webpanel [on/off]</red>`); }
                        prompt();
                    }
                    else { send(socket, `\n<red>Unknown command.</red>`); prompt(); }
                    break;

                // Board Interactions
                case 'LIST_BOARDS':
                    if (trimmed.startsWith('/deleteboard ')) {
                        const targetBoard = trimmed.substring(13).trim();
                        let delConn;
                        try {
                            delConn = await pool.getConnection();
                            const bRes = await delConn.query("SELECT id, created_by FROM boards WHERE title = ?", [targetBoard]);
                            if (bRes.length === 0) {
                                send(socket, `\n<red>Board 'p/${targetBoard}' not found.</red>\n`);
                            } else {
                                const boardOwner = bRes[0].created_by;
                                if (socket.user.privilege_level >= 5 || (socket.user.privilege_level >= 3 && boardOwner === socket.user.id)) {
                                    await delConn.query("DELETE FROM boards WHERE id = ?", [bRes[0].id]);
                                    send(socket, `\n<green>Board 'p/${targetBoard}' successfully deleted.</green>\n`);
                                } else { send(socket, `\n<red>Access Denied: You do not own this board.</red>\n`); }
                            }
                        } catch (err) { send(socket, `\n<red>Database error.</red>\n`); } finally { if (delConn) delConn.release(); }
                        await displayBoards(socket, pool);
                        
                    } else if (trimmed.startsWith('/createboard ')) {
                        const newBoardTitle = trimmed.substring(13).trim();
                        if (!/^[A-Za-z0-9]+$/.test(newBoardTitle)) {
                            send(socket, `\n<red>Invalid name. Letters and numbers only (no spaces).</red>\n`);
                            await displayBoards(socket, pool); break;
                        }
                        if (socket.user.privilege_level < 3) {
                            send(socket, `\n<red>Access Denied: Level 3+ required to create boards.</red>\n`);
                            await displayBoards(socket, pool); break;
                        }

                        let createConn;
                        try {
                            createConn = await pool.getConnection();
                            if (socket.user.privilege_level === 3) {
                                const countRes = await createConn.query("SELECT COUNT(*) as count FROM boards WHERE created_by = ?", [socket.user.id]);
                                if (Number(countRes[0].count) >= 1) {
                                    send(socket, `\n<red>Quota exceeded: Level 3 users can only create 1 board.</red>\n`);
                                    createConn.release(); await displayBoards(socket, pool); break;
                                }
                            }
                            const existing = await createConn.query("SELECT id FROM boards WHERE title = ?", [newBoardTitle]);
                            if (existing.length > 0) {
                                send(socket, `\n<red>Board 'p/${newBoardTitle}' already exists.</red>\n`);
                            } else {
                                await createConn.query("INSERT INTO boards (title, created_by) VALUES (?, ?)", [newBoardTitle, socket.user.id]);
                                send(socket, `\n<green>Board 'p/${newBoardTitle}' successfully created!</green>\n`);
                            }
                        } catch (err) { send(socket, `\n<red>Database error.</red>\n`); } finally { if (createConn) createConn.release(); }
                        await displayBoards(socket, pool);
                        
                    } else {
                        await handleBoardInput(socket, pool, trimmed, (newState) => {
                            state = newState;
                            if (newState === 'LOGGED_IN') prompt();
                            if (newState === 'LIST_POSTS') displayPosts(socket, pool);
                        });
                    }
                    break;

                // Post Interactions
                case 'LIST_POSTS':
                    if (trimmed.startsWith('/deletepost ')) {
                        const targetPost = parseInt(trimmed.substring(12).trim());
                        if (isNaN(targetPost)) { send(socket, `\n<red>Invalid post ID.</red>\n`); await displayPosts(socket, pool); break; }
                        
                        let delConn;
                        try {
                            delConn = await pool.getConnection();
                            const pRes = await delConn.query(`SELECT p.author_id, b.created_by as board_owner FROM posts p JOIN boards b ON p.board_id = b.id WHERE p.id = ? AND p.board_id = ?`, [targetPost, socket.currentBoard.id]);
                            if (pRes.length === 0) {
                                send(socket, `\n<red>Post #${targetPost} not found in this board.</red>\n`);
                            } else {
                                const post = pRes[0];
                                if (socket.user.privilege_level >= 5 || (socket.user.privilege_level >= 3 && post.board_owner === socket.user.id) || post.author_id === socket.user.id) {
                                    await delConn.query("DELETE FROM posts WHERE id = ?", [targetPost]);
                                    send(socket, `\n<green>Post #${targetPost} successfully deleted.</green>\n`);
                                } else { send(socket, `\n<red>Access Denied: You cannot delete this post.</red>\n`); }
                            }
                        } catch (err) { send(socket, `\n<red>Database error.</red>\n`); } finally { if (delConn) delConn.release(); }
                        await displayPosts(socket, pool);
                        
                    } else {
                        await handlePostInput(socket, pool, trimmed, (newState) => {
                            state = newState;
                            if (newState === 'LIST_BOARDS') displayBoards(socket, pool);
                            if (newState === 'WRITE_POST_TITLE') send(socket, "\n<green>--- New Post ---</green>\nTitle: ");
                        });
                    }
                    break;

                // Post Writing
                case 'WRITE_POST_TITLE':
                    if (!trimmed) { send(socket, "Title (required): "); return; }
                    socket.newPost = { title: trimmed, content: [] };
                    state = 'WRITE_POST_CONTENT';
                    send(socket, "\n<cyan>Enter post content (Submit an empty line to finish):</cyan>\n> ");
                    break;

                case 'WRITE_POST_CONTENT':
                    if (input === '') { 
                        let postConn;
                        try {
                            postConn = await pool.getConnection();
                            await postConn.query("INSERT INTO posts (board_id, author_id, title, content) VALUES (?, ?, ?, ?)", [socket.currentBoard.id, socket.user.id, socket.newPost.title, socket.newPost.content.join('\n')]);
                            send(socket, "\n<green>Post published!</green>\n");
                        } catch (err) { send(socket, "\n<red>Error saving post.</red>\n"); } finally { if (postConn) postConn.release(); }
                        state = 'LIST_POSTS';
                        await displayPosts(socket, pool);
                    } else {
                        socket.newPost.content.push(input); 
                        send(socket, "> ");
                    }
                    break;

                // Post Reading
                case 'READ_POST':
                    if (input === ' ' || trimmed.toLowerCase() === 'n') {
                        if (socket.readPost.currentIndex < socket.readPost.lines.length) {
                            displayReadPostChunk(socket);
                        } else {
                            state = 'LIST_POSTS'; await displayPosts(socket, pool);
                        }
                    } else {
                        state = 'LIST_POSTS'; await displayPosts(socket, pool);
                    }
                    break;
            }
        } catch (e) { console.error("Error:", e); }
    };

    socket.on('data', async (data) => {
        for (let i = 0; i < data.length; i++) {
            const charCode = data[i];

            // 1. Ignore Telnet Negotiation bytes (starts with 255/IAC)
            if (charCode === 255) { i += 2; continue; }

            // 2. Handle Backspace / Delete (ASCII 8, ASCII 127, PETSCII 20)
            if (charCode === 8 || charCode === 127 || charCode === 20) {
                if (socket.inputBuffer.length > 0) {
                    socket.inputBuffer = socket.inputBuffer.slice(0, -1);
                    // Erase character visually on client screen
                    if (socket.config.charset === 'petscii') {
                        socket.write(Buffer.from([20])); // C64 destructive backspace
                    } else {
                        socket.write(Buffer.from([8, 32, 8])); // VT100 destructive backspace
                    }
                }
                continue;
            }

            // 3. Handle Enter / Newline (CR=13 or LF=10)
            if (charCode === 13 || charCode === 10) {
                if (charCode === 10 && socket.lastCharCode === 13) continue; // Ignore LF right after CR
                socket.lastCharCode = charCode;

                // Echo newline sequence visually based on user's chosen linefeed config
                if (socket.config.charset === 'petscii') {
                    socket.write(Buffer.from([13]));
                } else {
                    const lfStr = socket.config.lf === 'cr' ? '\r' : (socket.config.lf === 'lf' ? '\n' : '\r\n');
                    socket.write(Buffer.from(lfStr));
                }

                // Extract line, wipe buffer, and process!
                const rawInput = socket.inputBuffer;
                const trimmedInput = rawInput.trim();
                socket.inputBuffer = '';
                await processCommand(rawInput, trimmedInput);
                continue;
            }

            socket.lastCharCode = charCode;

            // 4. Buffer and Echo Normal Characters
            if (charCode >= 32 || (socket.config.charset === 'petscii' && ((charCode >= 65 && charCode <= 90) || (charCode >= 193 && charCode <= 218)))) {
                
                // Convert bytes dynamically to standard UTF8 JS Strings
                const charStr = socket.config.charset === 'petscii' 
                    ? fromPetscii(Buffer.from([charCode])) 
                    : String.fromCharCode(charCode);
                
                socket.inputBuffer += charStr;

                // Handle visual echo back to the user
                if (state === 'REG_PASS' || state === 'REG_PASS_VERIFY' || state === 'LOGIN_PASS') {
                    socket.write(Buffer.from('*')); // Hide passwords
                } else {
                    socket.write(Buffer.from([charCode])); // Echo exact byte they sent
                }
            }
        }
    });

    socket.on('end', () => {});
    socket.on('error', () => {});
    prompt();
});

server.listen(2323, async () => {
    console.log('BBS Node Telnet server is live on port 2323');
    await initializeDefaultUser();
});

startWebServer(pool);