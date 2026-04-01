const { send } = require('./print');

async function displayBoards(socket, pool) {
    socket.boardPage = socket.boardPage || 1;
    socket.boardSort = socket.boardSort || 'alpha'; 

    const limit = Math.max(1, socket.config.rows - 9); // Adjusted for extra instruction line

    let conn;
    try {
        conn = await pool.getConnection();
        const countRes = await conn.query("SELECT COUNT(*) as total FROM boards");
        const totalBoards = Number(countRes[0].total);
        const totalPages = Math.ceil(totalBoards / limit) || 1;

        if (socket.boardPage > totalPages) socket.boardPage = totalPages;
        if (socket.boardPage < 1) socket.boardPage = 1;

        const offset = (socket.boardPage - 1) * limit;
        let orderBy = socket.boardSort === 'alpha' ? "b.title ASC" : "post_count DESC";

        const boards = await conn.query(`
            SELECT b.id, b.title, COUNT(p.id) as post_count 
            FROM boards b LEFT JOIN posts p ON b.id = p.board_id 
            GROUP BY b.id ORDER BY ${orderBy} LIMIT ? OFFSET ?
        `, [limit, offset]);

        send(socket, `\n<cyan>=== BOARDS LIST (Page ${socket.boardPage}/${totalPages}) ===</cyan>`);
        send(socket, `Sort: ${socket.boardSort === 'alpha' ? 'A-Z' : 'Most Posts'} (Type '/sort' to toggle)`);
        send(socket, "-".repeat(socket.config.cols));

        if (boards.length === 0) send(socket, "No boards exist yet.");
        else boards.forEach(b => {
            const titleStr = `p/${b.title}`;
            const countStr = `[${b.post_count} posts]`;
            const spacer = " ".repeat(Math.max(1, socket.config.cols - titleStr.length - countStr.length));
            send(socket, `<yellow>${titleStr}</yellow>${spacer}${countStr}`);
        });

        send(socket, "-".repeat(socket.config.cols));
        
        let instructions = "< and > to scroll | Type board name to enter | /back";
        if (socket.user.privilege_level >= 3) {
            instructions += "\n<cyan>Manage:</cyan> /createboard [name] | /deleteboard [name]";
        }
        
        send(socket, instructions);
        send(socket, "Command: ");
    } catch (err) { 
        send(socket, "<red>Error loading boards.</red>\nCommand: "); 
    } finally { 
        if (conn) conn.release(); 
    }
}

async function handleBoardInput(socket, pool, input, changeState) {
    if (input === '<') {
        socket.boardPage--;
        await displayBoards(socket, pool);
    } else if (input === '>') {
        socket.boardPage++; 
        await displayBoards(socket, pool);
    } else if (input === '/sort') {
        socket.boardSort = socket.boardSort === 'alpha' ? 'posts' : 'alpha';
        socket.boardPage = 1;
        await displayBoards(socket, pool);
    } else if (input === '/back') {
        changeState('LOGGED_IN');
    } else if (input.trim().length > 0) {
        let boardTitle = input.trim().replace(/^p\//, '');
        let conn;
        try {
            conn = await pool.getConnection();
            const res = await conn.query("SELECT * FROM boards WHERE title = ?", [boardTitle]);
            if (res.length > 0) {
                socket.currentBoard = res[0];
                socket.postPage = 1; 
                changeState('LIST_POSTS');
            } else {
                send(socket, `<red>Board 'p/${boardTitle}' not found.</red>`);
                await displayBoards(socket, pool);
            }
        } catch (err) { console.error(err); } finally { if (conn) conn.release(); }
    } else {
        await displayBoards(socket, pool);
    }
}

module.exports = { displayBoards, handleBoardInput };