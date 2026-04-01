const { send } = require('./print');

function trimString(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
}

// Automatically wraps text to fit screen width without slicing words
function wordWrap(text, maxCols) {
    const lines = [];
    const paragraphs = text.split(/\r?\n/);
    
    for (let p of paragraphs) {
        if (p.trim() === '') {
            lines.push('');
            continue;
        }
        
        let words = p.split(' ');
        let currentLine = '';
        
        for (let word of words) {
            if ((currentLine.length + word.length + (currentLine.length > 0 ? 1 : 0)) <= maxCols) {
                currentLine += (currentLine.length > 0 ? ' ' : '') + word;
            } else {
                if (currentLine.length > 0) lines.push(currentLine);
                // If a single word is insanely long, just cut it to maxCols
                if (word.length > maxCols) {
                    lines.push(word.substring(0, maxCols)); 
                } else {
                    currentLine = word;
                }
            }
        }
        if (currentLine.length > 0) lines.push(currentLine);
    }
    return lines;
}

async function displayPosts(socket, pool) {
    socket.postPage = socket.postPage || 1;
    const limit = Math.max(1, socket.config.rows - 9);

    let conn;
    try {
        conn = await pool.getConnection();
        const countRes = await conn.query("SELECT COUNT(*) as total FROM posts WHERE board_id = ?", [socket.currentBoard.id]);
        const totalPosts = Number(countRes[0].total);
        const totalPages = Math.ceil(totalPosts / limit) || 1;

        if (socket.postPage > totalPages) socket.postPage = totalPages;
        if (socket.postPage < 1) socket.postPage = 1;

        const offset = (socket.postPage - 1) * limit;

        const posts = await conn.query(`
            SELECT p.id, p.title, u.handle, p.created_at 
            FROM posts p JOIN users u ON p.author_id = u.id 
            WHERE p.board_id = ? ORDER BY p.id DESC LIMIT ? OFFSET ?
        `, [socket.currentBoard.id, limit, offset]);

        send(socket, `\n<cyan>=== p/${socket.currentBoard.title} (Page ${socket.postPage}/${totalPages}) ===</cyan>`);
        send(socket, "-".repeat(socket.config.cols));

        if (posts.length === 0) send(socket, "No posts here yet.");
        else posts.forEach(p => {
            const metaString = `[${p.id}]  by ${p.handle}`;
            const safeTitle = trimString(p.title, socket.config.cols - metaString.length - 2);
            send(socket, `<yellow>[${p.id}]</yellow> ${safeTitle} <cyan>by ${p.handle}</cyan>`);
        });

        send(socket, "-".repeat(socket.config.cols));
        let instructions = "< and > to scroll | Type Post ID to read | /back";
        if (socket.user.privilege_level >= 2) instructions += " | /post to write";
        
        send(socket, instructions);
        send(socket, "Command: ");
    } catch (err) { send(socket, "<red>Error loading posts.</red>\nCommand: "); } 
    finally { if (conn) conn.release(); }
}

async function handlePostInput(socket, pool, input, changeState) {
    if (input === '<') {
        socket.postPage--;
        await displayPosts(socket, pool);
    } else if (input === '>') {
        socket.postPage++;
        await displayPosts(socket, pool);
    } else if (input === '/back') {
        delete socket.currentBoard;
        changeState('LIST_BOARDS');
    } else if (input === '/post') {
        if (socket.user.privilege_level < 2) {
            send(socket, "\n<red>Access Denied: You need Verified (Level 2) status to post.</red>");
            await displayPosts(socket, pool);
        } else {
            changeState('WRITE_POST_TITLE'); 
        }
    } else if (!isNaN(input) && input !== '') {
        const postId = parseInt(input);
        await initReadPost(socket, pool, postId, changeState);
    } else {
        await displayPosts(socket, pool);
    }
}

async function initReadPost(socket, pool, postId, changeState) {
    let conn;
    try {
        conn = await pool.getConnection();
        const rows = await conn.query("SELECT p.title, p.content, p.created_at, u.handle FROM posts p JOIN users u ON p.author_id = u.id WHERE p.id = ? AND p.board_id = ?", [postId, socket.currentBoard.id]);
        
        if (rows.length === 0) {
            send(socket, `\n<red>Post #${postId} not found in this board.</red>\n`);
            await displayPosts(socket, pool);
            return;
        }
        
        const post = rows[0];
        socket.readPost = {
            title: post.title,
            handle: post.handle,
            date: new Date(post.created_at).toLocaleString(),
            lines: wordWrap(post.content, socket.config.cols),
            currentIndex: 0
        };
        
        changeState('READ_POST');
        displayReadPostChunk(socket);
    } catch (err) {
        console.error(err);
        send(socket, "\n<red>Error loading post.</red>\n");
        changeState('LIST_POSTS');
        await displayPosts(socket, pool);
    } finally {
        if (conn) conn.release();
    }
}

function displayReadPostChunk(socket) {
    const rp = socket.readPost;
    const availableRows = Math.max(5, socket.config.rows - 5); 

    if (rp.currentIndex === 0) {
        send(socket, `\n<cyan>--- ${rp.title} ---</cyan>`);
        send(socket, `<yellow>By ${rp.handle} on ${rp.date}</yellow>`);
        send(socket, "-".repeat(socket.config.cols));
    }

    const limit = rp.currentIndex + availableRows;
    for (let i = rp.currentIndex; i < limit && i < rp.lines.length; i++) {
        send(socket, rp.lines[i]);
    }
    
    rp.currentIndex = limit;

    send(socket, "-".repeat(socket.config.cols));
    if (rp.currentIndex < rp.lines.length) {
        send(socket, "Type <space> or 'n' to read more | <Enter> to go back");
    } else {
        send(socket, "<EOF> Press <Enter> to go back");
    }
    send(socket, "Command: ");
}

module.exports = { displayPosts, handlePostInput, displayReadPostChunk };