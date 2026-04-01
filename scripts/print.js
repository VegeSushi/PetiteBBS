const ANSI_RESET = "\x1b[0m";
const ANSI_COLORS = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m"
};

function toPetscii(text) {
    let res = [];
    for (let i = 0; i < text.length; i++) {
        let r = text.charCodeAt(i);
        
        // FIX 1: Ignore \r to prevent double-returns, and map \n to PETSCII 13.
        // This naturally preserves intentional blank lines (e.g., \n\n)
        if (r === 13) {
            continue; 
        } else if (r === 10) {
            res.push(13);
        } else if (r >= 97 && r <= 122) { 
            res.push(r - 32);
        } else if (r >= 65 && r <= 90) { 
            res.push(r + 128);
        } else if (r >= 32 && r <= 126) {
            switch (String.fromCharCode(r)) {
                case '_': case '~': res.push(45); break;
                case '`': res.push(39); break;
                case '\\': res.push(47); break;
                case '{': case '[': res.push(40); break;
                case '}': case ']': res.push(41); break;
                case '|': res.push(73); break;
                case '^': res.push(94); break;
                default: res.push(r); break;
            }
        } else {
            res.push(r); // Safely pass through other characters
        }
    }

    return Buffer.from(res);
}

function fromPetscii(buf) {
    let res = [];
    for (let i = 0; i < buf.length; i++) {
        let c = buf[i];
        
        // FIX 3: Map the PETSCII return key to a standard newline so the Node server reads it properly
        if (c === 13) {
            res.push(10); 
        } else if (c >= 65 && c <= 90) {
            res.push(c + 32);
        } else if (c >= 193 && c <= 218) {
            res.push(c - 128);
        } else {
            res.push(c);
        }
    }
    return Buffer.from(res).toString('utf8');
}

module.exports = {
    fromPetscii,
    send: (socket, text) => {
        const charset = socket.config ? socket.config.charset : 'ascii';
        const colorMode = socket.config ? socket.config.color : 'color';
        
        if (colorMode === 'mono') {
            text = text.replace(/<[^>]+>/g, '');
        }

        let outputBuf;
        
        if (charset === 'petscii') {
            // Append a standard \n, which toPetscii will perfectly map to a 13
            let petsciiBuf = toPetscii(text + '\n');
            
            if (colorMode === 'color') {
                let tempStr = petsciiBuf.toString('latin1');
                for (const [colorName, colorCode] of Object.entries(ANSI_COLORS)) {
                    // FIX 2: Added the 'i' (case-insensitive) flag because toPetscii shifts <cyan> to <CYAN>
                    const regex = new RegExp(`<${colorName}>(.*?)</${colorName}>`, 'gi');
                    tempStr = tempStr.replace(regex, `${colorCode}$1${ANSI_RESET}`);
                }
                outputBuf = Buffer.from(tempStr, 'latin1');
            } else {
                outputBuf = petsciiBuf;
            }
        } else {
            if (colorMode === 'color') {
                for (const [colorName, colorCode] of Object.entries(ANSI_COLORS)) {
                    const regex = new RegExp(`<${colorName}>(.*?)</${colorName}>`, 'g');
                    text = text.replace(regex, `${colorCode}$1${ANSI_RESET}`);
                }
            }
            outputBuf = Buffer.from(text + '\r\n', 'utf8');
        }

        socket.write(outputBuf);
    }
};