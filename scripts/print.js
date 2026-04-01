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
        
        // C64 strictly requires 13 (CR) for newlines.
        // This normalizes CR, LF, and CRLF seamlessly into a single 13.
        if (r === 13) {
            res.push(13);
            // Skip the following LF if it's a CRLF sequence
            if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) i++;
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
            res.push(r);
        }
    }
    return Buffer.from(res);
}

function fromPetscii(buf) {
    let res = [];
    for (let i = 0; i < buf.length; i++) {
        let c = buf[i];
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
        const lfMode = socket.config ? socket.config.lf : 'crlf';
        
        let lfStr = '\r\n';
        if (lfMode === 'cr') lfStr = '\r';
        else if (lfMode === 'lf') lfStr = '\n';

        if (colorMode === 'mono') {
            text = text.replace(/<[^>]+>/g, '');
        }

        let outputBuf;
        
        if (charset === 'petscii') {
            // Append a standard \n, which toPetscii dynamically maps to 13
            let petsciiBuf = toPetscii(text + '\n');
            
            if (colorMode === 'color') {
                let tempStr = petsciiBuf.toString('latin1');
                for (const [colorName, colorCode] of Object.entries(ANSI_COLORS)) {
                    const regex = new RegExp(`<${colorName}>(.*?)</${colorName}>`, 'gi');
                    tempStr = tempStr.replace(regex, `${colorCode}$1${ANSI_RESET}`);
                }
                outputBuf = Buffer.from(tempStr, 'latin1');
            } else {
                outputBuf = petsciiBuf;
            }
        } else {
            // Standardize all internal newlines to user's chosen format
            text = text.replace(/\r\n|\r|\n/g, lfStr);
            
            if (colorMode === 'color') {
                for (const [colorName, colorCode] of Object.entries(ANSI_COLORS)) {
                    const regex = new RegExp(`<${colorName}>(.*?)</${colorName}>`, 'g');
                    text = text.replace(regex, `${colorCode}$1${ANSI_RESET}`);
                }
            }
            outputBuf = Buffer.from(text + lfStr, 'utf8');
        }

        socket.write(outputBuf);
    }
};