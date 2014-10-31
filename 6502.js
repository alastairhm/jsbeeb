define(['utils', '6502.opcodes', 'via', 'acia', 'serial'],
    function (utils, opcodesAll, via, Acia, Serial) {
        "use strict";
        var hexword = utils.hexword;
        var signExtend = utils.signExtend;

        function Flags() {
            this.reset = function () {
                this.c = this.z = this.i = this.d = this.v = this.n = false;
            };
            this.debugString = function () {
                return (this.n ? "N" : "n") +
                    (this.v ? "V" : "v") +
                    "xx" +
                    (this.d ? "D" : "d") +
                    (this.i ? "I" : "i") +
                    (this.z ? "Z" : "z") +
                    (this.c ? "C" : "c");
            };

            this.asByte = function () {
                var temp = 0x30;
                if (this.c) temp |= 0x01;
                if (this.z) temp |= 0x02;
                if (this.i) temp |= 0x04;
                if (this.d) temp |= 0x08;
                if (this.v) temp |= 0x40;
                if (this.n) temp |= 0x80;
                return temp;
            };

            this.reset();
        }

        return function Cpu6502(model, dbgr, video, soundChip, cmos, config) {
            var self = this;
            if (config === undefined) config = {};
            if (!config.keyLayout)
                config.keyLayout = "physical";

            var opcodes = model.nmos ? opcodesAll.cpu6502(this) : opcodesAll.cpu65c12(this);

            this.model = model;
            this.memStatOffsetByIFetchBank = new Uint32Array(16);  // helps in master map of LYNNE for non-opcode read/writes
            this.memStatOffset = 0;
            this.memStat = new Uint8Array(512);
            this.memLook = new Int32Array(512);  // Cannot be unsigned as we use negative offsets
            this.ramRomOs = new Uint8Array(128 * 1024 + 17 * 16 * 16384);
            this.romOffset = 128 * 1024;
            this.osOffset = this.romOffset + 16 * 16 * 1024;
            this.a = this.x = this.y = this.s = 0;
            this.romsel = 0;
            this.acccon = 0;
            this.interrupt = 0;
            this.FEslowdown = [true, false, true, true, false, false, true, false];
            this.oldPcArray = new Uint16Array(256);
            this.oldAArray = new Uint8Array(256);
            this.oldXArray = new Uint8Array(256);
            this.oldYArray = new Uint8Array(256);
            this.oldPArray = new Uint8Array(256);
            this.oldPcIndex = 0;
            this.getPrevPc = function (index) {
                return this.oldPcArray[(this.oldPcIndex - index) & 0xff];
            };

            // BBC Master memory map (within ramRomOs array):
            // 00000 - 08000 -> base 32KB RAM
            // 08000 - 09000 -> ANDY - 4KB
            // 09000 - 0b000 -> HAZEL - 8KB
            // 0b000 - 10000 -> LYNNE - 20KB

            this.romSelect = function (b) {
                var c;
                this.romsel = b;
                var bankOffset = ((b & 15) << 14) + this.romOffset;
                var offset = bankOffset - 0x8000;
                for (c = 128; c < 192; ++c) this.memLook[c] = this.memLook[256 + c] = offset;
                var swram = model.swram[b & 15] ? 1 : 2;
                for (c = 128; c < 192; ++c) this.memStat[c] = this.memStat[256 + c] = swram;
                if (model.isMaster && (b & 0x80)) {
                    // 4Kb RAM (private RAM - ANDY)
                    // Zero offset as 0x8000 mapped to 0x8000
                    for (c = 128; c < 144; ++c) {
                        this.memLook[c] = this.memLook[256 + c] = 0;
                        this.memStat[c] = this.memStat[256 + c] = 1;
                    }
                }
            };

            this.writeAcccon = function (b) {
                this.acccon = b;
                // ACCCON is
                // IRR TST IJF ITU  Y  X  E  D
                //  7   6   5   4   3  2  1  0

                // Video offset (to LYNNE) is controlled by the "D" bit of ACCCON.
                // LYNNE lives at 0xb000 in our map, but the offset we use here is 0x8000
                // as the video circuitry will already be looking at 0x3000 or so above
                // the offset.
                self.videoDisplayPage = (b & 1) ? 0x8000 : 0x0000;
                // The RAM the processor sees for writes when executing OS instructions
                // is controlled by the "E" bit.
                this.memStatOffsetByIFetchBank[0xc] = this.memStatOffsetByIFetchBank[0xd] = (b & 2) ? 256 : 0;
                var i;
                // The "X" bit controls the "illegal" paging 20KB region overlay of LYNNE.
                var lowRamOffset = (b & 4) ? 0x8000 : 0;
                for (i = 48; i < 128; ++i) this.memLook[i] = lowRamOffset;
                // The "Y" bit pages in HAZEL at c000->dfff. HAZEL is mapped in our RAM
                // at 0x9000, so (0x9000 - 0xc000) = -0x3000 is needed as an offset.
                var hazelRAM = (b & 8) ? 1 : 2;
                var hazelOff = (b & 8) ? -0x3000 : this.osOffset - 0xc000;
                for (i = 192; i < 224; ++i) {
                    this.memLook[i] = this.memLook[i + 256] = hazelOff;
                    this.memStat[i] = this.memStat[i + 256] = hazelRAM;
                }
            };

            this.debugread = this.debugwrite = this.debugInstruction = null;

            // Works for unpaged RAM only (ie stack and zp)
            this.readmemZpStack = function (addr) {
                addr &= 0xffff;
                if (this.debugread) this.debugread(addr);
                return this.ramRomOs[addr];
            };
            this.writememZpStack = function (addr, b) {
                addr &= 0xffff;
                b |= 0;
                if (this.debugwrite) this.debugwrite(addr, b);
                this.ramRomOs[addr] = b;
            };

            // Handy debug function to read a string zero or \n terminated.
            this.readString = function (addr) {
                var s = "";
                for (; ;) {
                    var b = this.readmem(addr);
                    addr++;
                    if (b === 0 || b === 13) break;
                    s += String.fromCharCode(b);
                }
                return s;
            };

            this.findString = function (string, addr) {
                addr = addr | 0;
                for (; addr < 0xffff; ++addr) {
                    for (var i = 0; i < string.length; ++i) {
                        if (this.readmem(addr + i) !== string.charCodeAt(i)) break;
                    }
                    if (i === string.length) {
                        return addr;
                    }
                }
                return null;
            };

            this.is1MHzAccess = function (addr) {
                addr &= 0xffff;
                return (addr >= 0xfc00 && addr < 0xff00 && (addr < 0xfe00 || this.FEslowdown[(addr >> 5) & 7]));
            };

            this.readDevice = function (addr) {
                if (model.isMaster && (self.acccon & 0x40)) {
                    // TST bit of ACCCON
                    return self.ramRomOs[this.osOffset + (addr & 0x3fff)];
                }
                addr &= 0xffff;
                switch (addr & ~0x0003) {
                    case 0xfc20:
                    case 0xfc24:
                    case 0xfc28:
                    case 0xfc2c:
                    case 0xfc30:
                    case 0xfc34:
                    case 0xfc38:
                    case 0xfc3c:
                        // SID Chip.
                        break;
                    case 0xfc40:
                    case 0xfc44:
                    case 0xfc48:
                    case 0xfc4c:
                    case 0xfc50:
                    case 0xfc54:
                    case 0xfc58:
                    case 0xfc5c:
                        // IDE
                        break;
                    case 0xfe00:
                    case 0xfe04:
                        return this.crtc.read(addr);
                    case 0xfe08:
                    case 0xfe0c:
                        return this.acia.read(addr);
                    case 0xfe10:
                    case 0xfe14:
                        return this.serial.read(addr);
                    case 0xfe18:
                        if (model.isMaster) return this.adconverter.read(addr);
                        break;
                    case 0xfe24:
                    case 0xfe28:
                        if (model.isMaster) return this.fdc.read(addr);
                        break;
                    case 0xfe34:
                        if (model.isMaster) return this.acccon;
                        break;
                    case 0xfe40:
                    case 0xfe44:
                    case 0xfe48:
                    case 0xfe4c:
                    case 0xfe50:
                    case 0xfe54:
                    case 0xfe58:
                    case 0xfe5c:
                        return this.sysvia.read(addr);
                    case 0xfe60:
                    case 0xfe64:
                    case 0xfe68:
                    case 0xfe6c:
                    case 0xfe70:
                    case 0xfe74:
                    case 0xfe78:
                    case 0xfe7c:
                        return this.uservia.read(addr);
                    case 0xfe80:
                    case 0xfe84:
                    case 0xfe88:
                    case 0xfe8c:
                    case 0xfe90:
                    case 0xfe94:
                    case 0xfe98:
                    case 0xfe9c:
                        if (!model.isMaster)
                            return this.fdc.read(addr);
                        break;
                    case 0xfec0:
                    case 0xfec4:
                    case 0xfec8:
                    case 0xfecc:
                    case 0xfed0:
                    case 0xfed4:
                    case 0xfed8:
                    case 0xfedc:
                        if (!model.isMaster) return this.adconverter.read(addr);
                        break;
                    case 0xfee0:
                    case 0xfee4:
                    case 0xfee8:
                    case 0xfeec:
                    case 0xfef0:
                    case 0xfef4:
                    case 0xfef8:
                    case 0xfefc:
                        return this.tube.read(addr);
                }
//                console.log("Unhandled peripheral read of", addr);
//                stop(true);
                if (addr >= 0xfc00 && addr < 0xfe00) return 0xff;
                return addr >> 8;
            };

            this.videoRead = function (addr) {
                return this.ramRomOs[addr | self.videoDisplayPage] | 0;
            };

            this.readmem = function (addr) {
                addr &= 0xffff;
                if (this.memStat[this.memStatOffset + (addr >>> 8)]) {
                    var offset = this.memLook[this.memStatOffset + (addr >>> 8)];
                    if (this.debugread) this.debugread(addr, offset);
                    return this.ramRomOs[offset + addr] | 0;
                } else {
                    if (this.debugread) this.debugread(addr);
                    return this.readDevice(addr) | 0;
                }
            };

            this.writemem = function (addr, b) {
                addr &= 0xffff;
                b |= 0;
                if (this.debugwrite) this.debugwrite(addr, b);
                if (this.memStat[this.memStatOffset + (addr >>> 8)] === 1) {
                    var offset = this.memLook[this.memStatOffset + (addr >>> 8)];
                    this.ramRomOs[offset + addr] = b;
                    return;
                }
                if (addr < 0xfc00 || addr >= 0xff00) return;
                this.writeDevice(addr, b);
            };
            this.writeDevice = function (addr, b) {
                b |= 0;
                switch (addr & ~0x0003) {
                    case 0xfc20:
                    case 0xfc24:
                    case 0xfc28:
                    case 0xfc2c:
                    case 0xfc30:
                    case 0xfc34:
                    case 0xfc38:
                    case 0xfc3c:
                        // SID chip
                        break;
                    case 0xfc40:
                    case 0xfc44:
                    case 0xfc48:
                    case 0xfc4c:
                    case 0xfc50:
                    case 0xfc54:
                    case 0xfc58:
                    case 0xfc5c:
                        // IDE
                        break;
                    case 0xfe00:
                    case 0xfe04:
                        return this.crtc.write(addr, b);
                    case 0xfe08:
                    case 0xfe0c:
                        return this.acia.write(addr, b);
                    case 0xfe10:
                    case 0xfe14:
                        return this.serial.write(addr, b);
                    case 0xfe18:
                        if (this.isMaster)
                            return this.adconverter.write(addr, b);
                        break;
                    case 0xfe20:
                        return this.ula.write(addr, b);
                    case 0xfe24:
                        if (model.isMaster) {
                            return this.fdc.write(addr, b);
                        }
                        return this.ula.write(addr, b);
                    case 0xfe28:
                        if (model.isMaster) {
                            return this.fdc.write(addr, b);
                        }
                        break;
                    case 0xfe30:
                        return this.romSelect(b);
                    case 0xfe34:
                        if (model.isMaster) {
                            return this.writeAcccon(b);
                        }
                        break;
                    case 0xfe40:
                    case 0xfe44:
                    case 0xfe48:
                    case 0xfe4c:
                    case 0xfe50:
                    case 0xfe54:
                    case 0xfe58:
                    case 0xfe5c:
                        return this.sysvia.write(addr, b);
                    case 0xfe60:
                    case 0xfe64:
                    case 0xfe68:
                    case 0xfe6c:
                    case 0xfe70:
                    case 0xfe74:
                    case 0xfe78:
                    case 0xfe7c:
                        return this.uservia.write(addr, b);
                    case 0xfe80:
                    case 0xfe84:
                    case 0xfe88:
                    case 0xfe8c:
                    case 0xfe90:
                    case 0xfe94:
                    case 0xfe98:
                    case 0xfe9c:
                        if (!model.isMaster)
                            return this.fdc.write(addr, b);
                        break;
                    case 0xfec0:
                    case 0xfec4:
                    case 0xfec8:
                    case 0xfecc:
                    case 0xfed0:
                    case 0xfed4:
                    case 0xfed8:
                    case 0xfedc:
                        if (!model.isMaster)
                            return this.adconverter.write(addr, b);
                        break;
                    case 0xfee0:
                    case 0xfee4:
                    case 0xfee8:
                    case 0xfeec:
                    case 0xfef0:
                    case 0xfef4:
                    case 0xfef8:
                    case 0xfefc:
                        return this.tube.write(addr, b);
                }
//                console.log("Unhandled peripheral write to", addr);
//                stop(true);
            };

            this.incpc = function () {
                this.pc = (this.pc + 1) & 0xffff;
            };

            this.getb = function () {
                var result = this.readmem(this.pc);
                this.incpc();
                return result | 0;
            };

            this.getw = function () {
                var result = this.readmem(this.pc) | 0;
                this.incpc();
                result |= (this.readmem(this.pc) | 0) << 8;
                this.incpc();
                return result | 0;
            };

            this.checkInt = function () {
                this.takeInt = (this.interrupt && !this.p.i);
            };

            this.loadRom = function (name, offset) {
                name = "roms/" + name;
                console.log("Loading ROM from " + name);
                var data = utils.loadData(name);
                var len = data.length;
                if (len != 16384 && len != 8192) {
                    throw "Broken rom file";
                }
                for (var i = 0; i < len; ++i) {
                    this.ramRomOs[offset + i] = data[i];
                }
            };

            this.loadOs = function (os) {
                var i;
                os = "roms/" + os;
                console.log("Loading OS from " + os);
                var data = utils.loadData(os);
                var len = data.length;
                if (len < 0x4000 || (len & 0x3fff)) throw "Broken ROM file (length=" + len + ")";
                for (i = 0; i < 0x4000; ++i) {
                    this.ramRomOs[this.osOffset + i] = data[i];
                }
                var numExtraBanks = (len - 0x4000) / 0x4000;
                var romIndex = 16 - numExtraBanks;
                for (i = 0; i < numExtraBanks; ++i) {
                    var srcBase = 0x4000 + 0x4000 * i;
                    var destBase = this.romOffset + (romIndex + i) * 0x4000;
                    for (var j = 0; j < 0x4000; ++j) {
                        this.ramRomOs[destBase + j] = data[srcBase + j];
                    }
                }

                for (i = 1; i < arguments.length; ++i) {
                    romIndex--;
                    this.loadRom(arguments[i], this.romOffset + romIndex * 0x4000);
                }
            };

            this.reset = function (hard) {
                var i;
                if (hard) {
                    for (i = 0; i < 16; ++i) this.memStatOffsetByIFetchBank[i] = 0;
                    if (!model.isTest) {
                        for (i = 0; i < 128; ++i) this.memStat[i] = this.memStat[256 + i] = 1;
                        for (i = 128; i < 256; ++i) this.memStat[i] = this.memStat[256 + i] = 2;
                        for (i = 0; i < 128; ++i) this.memLook[i] = this.memLook[256 + i] = 0;
                        for (i = 48; i < 128; ++i) this.memLook[256 + i] = 32768;
                        for (i = 128; i < 192; ++i) this.memLook[i] = this.memLook[256 + i] = this.romOffset - 0x8000;
                        for (i = 192; i < 256; ++i) this.memLook[i] = this.memLook[256 + i] = this.osOffset - 0xc000;

                        for (i = 0xfc; i < 0xff; ++i) this.memStat[i] = this.memStat[256 + i] = 0;
                    } else {
                        // Test sets everything as RAM.
                        for (i = 0; i < 256; ++i) {
                            this.memStat[i] = this.memStat[256 + i] = 1;
                            this.memLook[i] = this.memLook[256 + i] = 0;
                        }
                    }
                    this.videoDisplayPage = 0;
                    this.disassembler = new opcodes.Disassemble(this);
                    this.sysvia = via.SysVia(this, soundChip, cmos, model.isMaster);
                    this.uservia = via.UserVia(this, model.isMaster, config.keyLayout);
                    this.acia = new Acia(this, soundChip.toneGenerator);
                    this.serial = new Serial(this.acia);
                    this.fdc = new model.Fdc(this);
                    this.crtc = video.crtc;
                    this.ula = video.ula;
                    this.adconverter = { read: function () {
                        return 0xff;
                    }, write: function () {
                    }};
                    this.tube = { read: function () {
                        return 0xff;
                    }, write: function () {
                    }};
                    this.sysvia.reset();
                    this.uservia.reset();
                }
                this.cycles = 0;
                this.pc = this.readmem(0xfffc) | (this.readmem(0xfffd) << 8);
                this.p = new Flags();
                this.p.i = true;
                this.nmi = false;
                this.halted = false;
                video.reset(this, this.sysvia);
                if (hard) soundChip.reset();
            };

            this.updateKeyLayout = function() {
                this.sysvia.setKeyLayout(config.keyLayout);
            };

            this.setzn = function (v) {
                v &= 0xff;
                this.p.z = !v;
                this.p.n = !!(v & 0x80);
                return v | 0;
            };

            this.push = function (v) {
                this.writememZpStack(0x100 + this.s, v);
                this.s = (this.s - 1) & 0xff;
            };

            this.pull = function () {
                this.s = (this.s + 1) & 0xff;
                return this.readmemZpStack(0x100 + this.s);
            };

            this.polltimeAddr = function (cycles, addr) {
                cycles = cycles | 0;
                if (this.is1MHzAccess(addr)) {
                    cycles += 1 + ((cycles ^ this.cycles) & 1);
                }
                this.polltime(cycles);
            };

            this.polltime = function (cycles) {
                cycles |= 0;
                this.cycles -= cycles;
                this.sysvia.polltime(cycles);
                this.uservia.polltime(cycles);
                this.fdc.polltime(cycles);
                this.acia.polltime(cycles);
                video.polltime(cycles);
                soundChip.polltime(cycles);
            };

            this.NMI = function (nmi) {
                this.nmi = !!nmi;
            };

            this.brk = function () {
                var nextByte = this.pc + 1;
                this.push(nextByte >>> 8);
                this.push(nextByte & 0xff);
                this.push(this.p.asByte());
                this.pc = this.readmem(0xfffe) | (this.readmem(0xffff) << 8);
                this.p.i = true;
                if (!model.nmos) {
                    this.p.d = false;
                    this.takeInt = false;
                }
            };

            this.branch = function (taken) {
                var offset = signExtend(this.getb());
                if (!taken) {
                    this.polltime(1);
                    this.checkInt();
                    this.polltime(1);
                    return;
                }
                var newPc = (this.pc + offset) & 0xffff;
                var pageCrossed = !!((this.pc & 0xff00) ^ (newPc & 0xff00));
                this.pc = newPc;
                this.polltime(pageCrossed ? 3 : 1);
                this.checkInt();
                this.polltime(pageCrossed ? 1 : 2);
            };

            function adcNonBCD(addend) {
                var result = (self.a + addend + (self.p.c ? 1 : 0));
                self.p.v = !!((self.a ^ result) & (addend ^ result) & 0x80);
                self.p.c = !!(result & 0x100);
                self.a = result & 0xff;
                self.setzn(self.a);
            }

            // For flags and stuff see URLs like:
            // http://www.visual6502.org/JSSim/expert.html?graphics=false&a=0&d=a900f86911eaeaea&steps=16
            function adcBCD(addend) {
                var ah = 0;
                var tempb = (self.a + addend + (self.p.c ? 1 : 0)) & 0xff;
                self.p.z = !tempb;
                var al = (self.a & 0xf) + (addend & 0xf) + (self.p.c ? 1 : 0);
                if (al > 9) {
                    al -= 10;
                    al &= 0xf;
                    ah = 1;
                }
                ah += (self.a >>> 4) + (addend >>> 4);
                self.p.n = !!(ah & 8);
                self.p.v = !((self.a ^ addend) & 0x80) && !!((self.a ^ (ah << 4)) & 0x80);
                self.p.c = false;
                if (ah > 9) {
                    self.p.c = true;
                    ah -= 10;
                    ah &= 0xf;
                }
                self.a = ((al & 0xf) | (ah << 4)) & 0xff;
            }

            // With reference to c64doc: http://vice-emu.sourceforge.net/plain/64doc.txt
            // and http://www.visual6502.org/JSSim/expert.html?graphics=false&a=0&d=a900f8e988eaeaea&steps=18
            function sbcBCD(subend) {
                var carry = self.p.c ? 0 : 1;
                var al = (self.a & 0xf) - (subend & 0xf) - carry;
                var ah = (self.a >>> 4) - (subend >>> 4);
                if (al & 0x10) {
                    al = (al - 6) & 0xf;
                    ah--;
                }
                if (ah & 0x10) {
                    ah = (ah - 6) & 0xf;
                }

                var result = self.a - subend - carry;
                self.p.n = !!(result & 0x80);
                self.p.z = !(result & 0xff);
                self.p.v = !!((self.a ^ result) & (subend ^ self.a) & 0x80);
                self.p.c = !(result & 0x100);
                self.a = al | (ah << 4);
            }

            function adcBCDcmos(addend) {
                self.polltime(1); // One more cycle, apparently
                var carry = self.p.c ? 1 : 0;
                var al = (self.a & 0xf) + (addend & 0xf) + carry;
                var ah = (self.a >>> 4) + (addend >>> 4);
                if (al > 9) {
                    al = (al - 10) & 0xf;
                    ah++;
                }
                self.p.v = !((self.a ^ addend) & 0x80) && !!((self.a ^ (ah << 4)) & 0x80);
                self.p.c = false;
                if (ah > 9) {
                    ah = (ah - 10) & 0xf;
                    self.p.c = true;
                }
                self.a = self.setzn(al | (ah << 4));
            }

            function sbcBCDcmos(subend) {
                self.polltime(1); // One more cycle, apparently
                var carry = self.p.c ? 0 : 1;
                var al = (self.a & 0xf) - (subend & 0xf) - carry;
                var result = self.a - subend - carry;
                if (result < 0) {
                    result -= 0x60;
                }
                if (al < 0) result -= 0x06;

                adcNonBCD(subend ^ 0xff); // For flags
                self.a = self.setzn(result);
            }

            if (model.nmos) {
                this.adc = function (addend) {
                    if (!this.p.d) {
                        adcNonBCD(addend);
                    } else {
                        adcBCD(addend);
                    }
                };

                this.sbc = function (subend) {
                    if (!this.p.d) {
                        adcNonBCD(subend ^ 0xff);
                    } else {
                        sbcBCD(subend);
                    }
                };
            } else {
                this.adc = function (addend) {
                    if (!this.p.d) {
                        adcNonBCD(addend);
                    } else {
                        adcBCDcmos(addend);
                    }
                };

                this.sbc = function (subend) {
                    if (!this.p.d) {
                        adcNonBCD(subend ^ 0xff);
                    } else {
                        sbcBCDcmos(subend);
                    }
                };
            }

            this.arr = function (arg) {
                // Insane instruction. I started with b-em source, but ended up using:
                // http://www.6502.org/users/andre/petindex/local/64doc.txt as reference,
                // tidying up as needed and fixing a couple of typos.
                if (this.p.d) {
                    var temp = this.a & arg;

                    var ah = temp >>> 4;
                    var al = temp & 0x0f;

                    this.p.n = this.p.c;
                    this.a = (temp >>> 1) | (this.p.c ? 0x80 : 0x00);
                    this.p.z = !this.a;
                    this.p.v = (temp ^ this.a) & 0x40;

                    if ((al + (al & 1)) > 5)
                        this.a = (this.a & 0xf0) | ((this.a + 6) & 0xf);

                    this.p.c = (ah + (ah & 1)) > 5;
                    if (this.p.c)
                        this.a = (this.a + 0x60) & 0xff;
                } else {
                    this.a = this.a & arg;
                    this.p.v = !!(((this.a >> 7) ^ (this.a >>> 6)) & 0x01);
                    this.a >>>= 1;
                    if (this.p.c) this.a |= 0x80;
                    this.setzn(this.a);
                    this.p.c = !!(this.a & 0x40);
                }
            };

            this.runner = opcodes.runInstruction;

            this.execute = function (numCyclesToRun) {
                this.halted = false;
                this.cycles += numCyclesToRun;
                while (!this.halted && this.cycles > 0) {
                    this.oldPcIndex = (this.oldPcIndex + 1) & 0xff;
                    this.oldPcArray[this.oldPcIndex] = this.pc;
                    this.memStatOffset = this.memStatOffsetByIFetchBank[this.pc >>> 12];
                    var opcode = this.readmem(this.pc);
                    if (this.debugInstruction && this.getPrevPc(2) !== this.pc && this.debugInstruction(this.pc, opcode)) {
                        return false;
                    }
                    this.incpc();
                    this.runner.run(opcode);
                    this.oldAArray[this.oldPcIndex] = this.a;
                    this.oldXArray[this.oldPcIndex] = this.x;
                    this.oldYArray[this.oldPcIndex] = this.y;
                    this.oldPArray[this.oldPcIndex] = this.p.asByte();
                    if (this.takeInt) {
                        this.takeInt = false;
                        this.push(this.pc >>> 8);
                        this.push(this.pc & 0xff);
                        this.push(this.p.asByte() & ~0x10);
                        this.pc = this.readmem(0xfffe) | (this.readmem(0xffff) << 8);
                        this.p.i = true;
                        this.polltime(7);
                    }
                    if (this.nmi) {
                        this.push(this.pc >>> 8);
                        this.push(this.pc & 0xff);
                        this.push(this.p.asByte() & ~0x10);
                        this.pc = this.readmem(0xfffa) | (this.readmem(0xfffb) << 8);
                        this.p.i = true;
                        this.polltime(7);
                        this.nmi = false;
                        if (!model.nmos)
                            this.p.d = false;
                    }
                }
                return true;
            };

            this.stop = function () {
                this.halted = true;
            };

            this.dumpTime = function () {
                for (var i = 1; i < 256; ++i) {
                    var j = (i + this.oldPcIndex) & 255;
                    console.log(utils.hexword(this.oldPcArray[j]),
                        (this.disassembler.disassemble(this.oldPcArray[j], true)[0] + "                       ").substr(0, 15),
                        utils.hexbyte(this.oldAArray[j]),
                        utils.hexbyte(this.oldXArray[j]),
                        utils.hexbyte(this.oldYArray[j]));
                }
            };

            if (model.os.length)
                this.loadOs.apply(this, model.os);
            this.reset(true);

            dbgr.setCpu(this);
        };
    }
);
