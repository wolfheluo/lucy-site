// =====================================================================
//  HackerCodeRain：背景「偽駭客代碼」產生器（Matrix 風）
//  - 演算法移植自經典 hacker code generator snippet（保留原味結構）
//  - 改造成 React 元件：輸出到背景層 div、批次 flush（非逐字 DOM）
//  - 自動清理所有 timer；pointer-events: none 不擋互動
//  - 只在 tool 背景（z-index 低於內容），玻璃面板後模糊穿透
// =====================================================================
import { useEffect, useRef } from "react";

export default function HackerCodeRain() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (rm) return; // reduced-motion：靜止背景

    // ── 輸出（批次 flush，避免逐字 DOM 寫入）────────────────────
    let pending = "";
    let lastTimer: number | undefined;
    let flushing = false;

    const flush = () => {
      flushing = false;
      if (!pending) return;
      el.textContent += pending;
      pending = "";
      if (el.textContent.length > 7000) {
        el.textContent = el.textContent.slice(2500);
      }
      el.scrollTop = el.scrollHeight;
    };
    const emit = (ch: string) => {
      pending += ch;
      if (!flushing) {
        flushing = true;
        lastTimer = window.setTimeout(flush, 60);
      }
    };

    // ── 產生器（原 snippet 演算法，minified 保留）────────────────
    let a = ""; // 目前累積的偽代碼段
    let n = 0; // 巢狀深度
    let u = 0;
    const e: string[] = []; // 已用識別字
    const g: string[] = [];
    const h: (null | { name: string })[] = [];
    const A = Object.keys(window);

    // 逐字輸出 b，完成後呼叫 cb（5ms/字，鏈式 timer 可單一清理）
    const c = (b: string, cb?: () => void) => {
      if (b.length === 0) {
        cb?.();
        return;
      }
      let i = 0;
      const step = () => {
        if (i >= b.length) {
          cb?.();
          return;
        }
        emit(b.charAt(i));
        i += 1;
        lastTimer = window.setTimeout(step, 5);
      };
      step();
    };

    // 隨機識別字串（5-9 字元）
    const k = (): string => {
      let out = "";
      const len = Math.floor(5 * Math.random()) + 5;
      for (let f = 0; f < len; f++) {
        let kind = Math.floor(3 * Math.random());
        if (f === 0 && kind === 2) kind -= Math.floor(1 * Math.random()) + 1;
        out += String.fromCharCode(
          Math.floor(Math.random() * (kind && kind !== 1 ? 10 : 26)) +
            (kind ? (kind === 1 ? 97 : 48) : 65)
        );
      }
      return out;
    };

    const l = (): string => {
      switch (Math.floor(5 * Math.random())) {
        case 0:
          return "true";
        case 1:
          return "'$v1' == '$v1'";
        case 2:
          return (e[Math.floor(Math.random() * e.length)] || "$v1") + " == '$v2'";
        case 3:
          return (e[Math.floor(Math.random() * e.length)] || "$v1") + " > $r1";
        default:
          return "window." + A[Math.floor(Math.random() * A.length)];
      }
    };

    const q = () => {
      u++;
      n++;
    };

    const B = () => {
      u = 0;
      let b = Math.floor(16 * Math.random());
      // b 落在「需關閉區塊」(4, 10-13) 但沒有開啟中的區塊 → 重抽
      while ((b >= 10 && b < 14 || b === 4) && n === 0) {
        b = Math.floor(16 * Math.random());
      }
      if (n > 10) b = 4;
      switch (b) {
        case 0:
          a += "$tfor (var $v1 = 0; $v1 < $r1; $v1++) {";
          g.push("for");
          h.push(null);
          q();
          break;
        case 1:
          a +=
            "$tvar $v1 = Math.floor(Math.random() * $r1) + $r1;\n$twhile($v1 > $r1) {\n$t\tconsole.log('Hacker ' + $e1 + '!');\n$t\tvar $v2 = '$v3';\n$t}";
          break;
        case 2:
          a += "$tdo {";
          g.push("do");
          h.push(null);
          q();
          break;
        case 3:
          a += "$twhile (" + l() + ") {";
          g.push("while");
          h.push(null);
          q();
          break;
        case 10:
        case 11:
        case 12:
        case 13:
        case 4:
          if (n > 0) {
            const top = g[g.length - 1];
            const handler = h[h.length - 1];
            const withElse = Math.random() > 0.5;
            switch (top) {
              case "do":
                a += "$t} while ($e1 != $v2);";
                break;
              case "while":
                a += "$t}";
                break;
              case "if":
                a += withElse ? "$t} else {" : "$t}";
                break;
              case "for":
                a += "$t}";
                break;
              case "xhr":
                a += "$t}\n$t" + (handler?.name ?? "") + ".send($e1);";
                break;
              case "else":
                a += "$t}";
                break;
            }
            if (withElse && top === "if") {
              u = 1;
              g.pop();
              h.pop();
              g.push("else");
              h.push(null);
            } else {
              g.pop();
              h.pop();
              n--;
            }
          }
          break;
        case 5:
          a += "$tif (" + l() + ") {";
          g.push("if");
          h.push(null);
          q();
          break;
        case 6:
        case 7:
        case 8:
        case 9:
          if (Math.random() > 0.5) {
            if (Math.random() > 0.5) {
              if (Math.random() > 0.75) {
                let s = "'";
                const len = Math.floor(160 * Math.random()) + 16;
                for (let i2 = 0; i2 < len; i2++) {
                  const hex = (Math.floor(254 * Math.random()) + 1).toString(16);
                  s += "\\x" + "00".substr(hex.length) + hex;
                  if (i2 % 10 === 0) s += "' + \n$t'";
                }
                a += "$tvar $v1 = " + (s + "';");
              } else a += "$tvar $v1 = '$s1' + $e1;";
            } else a += "$tvar $v1 = '$s1';";
          } else {
            a = Math.random() > 0.5 ? a + "$tvar $v1 = $r1 * $r2;" : a + "$tvar $v1 = $r1;";
          }
          break;
        case 14:
          a +=
            "$tvar $v1 = new XMLHttpRequest();\n$t$v1.open('POST', 'http://$s1$s2.onion/$s3.php', true);\n$t$v1.send($e1);";
          break;
        case 15: {
          const id = k();
          e.push(id);
          a +=
            "$tvar " +
            id +
            " = new XMLHttpRequest();\n$t" +
            id +
            ".open('POST', 'http://$s1$s2.onion/$s3.php', true);\n$t" +
            id +
            ".onload = function() {";
          g.push("xhr");
          h.push({ name: id });
          q();
          break;
        }
      }
      // 替換 $ 佔位符
      const re = /\$[vres]\d{1}/gi;
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(a)) !== null && guard++ < 5000) {
        for (let f = 0; f < m.length; f++) {
          const d = m[f];
          let p = k();
          if (d.charAt(1).toUpperCase() !== "V" && d.charAt(1).toUpperCase() === "E" && e.length > 0) {
            p = e[Math.floor(Math.random() * e.length)];
          }
          if (d.charAt(1).toUpperCase() === "R") p = String(Math.floor(65535 * Math.random()) + 255);
          else if (d.charAt(1).toUpperCase() === "S") p = k();
          else if (e.indexOf(p) === -1) e.push(p);
          a = a.split(d).join(p);
          re.lastIndex = 0;
        }
      }
      if (e.length > 100) e.splice(99, e.length - 100);
      a = a.split("$t").join("\t".repeat(Math.max(0, n - u)));
      a += "\n";
      D();
    };

    const D = () => {
      c(a, () => {
        a = "";
        lastTimer = window.setTimeout(B, 100);
      });
    };

    lastTimer = window.setTimeout(B, 100);

    return () => {
      if (lastTimer !== undefined) window.clearTimeout(lastTimer);
      // 清掉 flush 殘留
      flush();
      el.textContent = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} className="hack-rain" aria-hidden="true" />;
}
