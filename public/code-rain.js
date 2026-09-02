/* =====================================================================
 *  code-rain.js —— 偽駭客代碼流背景（單一來源）
 *  使用端：
 *    - React：src/components/HackerCodeRain.tsx（動態載入後呼叫）
 *    - 分享頁：tools/file-vault/server/share-page.ts（<script> 引入）
 *  演算法移植自經典 hacker code generator snippet。
 *  window.startCodeRain(el) → 回傳 stop()（清理所有 timer）
 * ===================================================================== */
(function (global) {
  "use strict";

  function startCodeRain(el) {
    // reduced-motion / 無容器 → 空操作
    if (!el) return function () {};
    if (global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return function () {};
    }

    var stopped = false;

    // 批次輸出（避免逐字 DOM 寫入）
    var pending = "";
    var lastTimer = null;
    var flushing = false;

    function flush() {
      flushing = false;
      if (stopped || !pending) return;
      el.textContent += pending;
      pending = "";
      if (el.textContent.length > 7000) {
        el.textContent = el.textContent.slice(2500);
      }
      el.scrollTop = el.scrollHeight;
    }
    function emit(ch) {
      pending += ch;
      if (!flushing) {
        flushing = true;
        lastTimer = global.setTimeout(flush, 60);
      }
    }

    // ── 產生器（原 snippet 演算法）────────────────────────────
    var a = ""; // 累積偽代碼段
    var n = 0; // 巢狀深度
    var u = 0;
    var e = []; // 已用識別字
    var g = [];
    var h = [];
    var A = Object.keys(global);

    // 逐字輸出 b（5ms/字），完成後 cb
    function c(b, cb) {
      var i = 0;
      function step() {
        if (stopped) return;
        if (i >= b.length) {
          if (cb) cb();
          return;
        }
        emit(b.charAt(i));
        i += 1;
        lastTimer = global.setTimeout(step, 5);
      }
      if (b.length === 0) {
        if (cb) cb();
        return;
      }
      step();
    }

    // 隨機識別字串
    function k() {
      var out = "";
      var len = Math.floor(5 * Math.random()) + 5;
      for (var f = 0; f < len; f++) {
        var kind = Math.floor(3 * Math.random());
        if (f === 0 && kind === 2) kind -= Math.floor(1 * Math.random()) + 1;
        out += String.fromCharCode(
          Math.floor(Math.random() * (kind && kind !== 1 ? 10 : 26)) +
            (kind ? (kind === 1 ? 97 : 48) : 65)
        );
      }
      return out;
    }

    function l() {
      switch (Math.floor(5 * Math.random())) {
        case 0: return "true";
        case 1: return "'$v1' == '$v1'";
        case 2: return (e[Math.floor(Math.random() * e.length)] || "$v1") + " == '$v2'";
        case 3: return (e[Math.floor(Math.random() * e.length)] || "$v1") + " > $r1";
        default: return "window." + A[Math.floor(Math.random() * A.length)];
      }
    }

    function q() {
      u++;
      n++;
    }

    function B() {
      if (stopped) return;
      u = 0;
      var b = Math.floor(16 * Math.random());
      while ((b >= 10 && b < 14 || b === 4) && n === 0) {
        b = Math.floor(16 * Math.random());
      }
      if (n > 10) b = 4;
      switch (b) {
        case 0:
          a += "$tfor (var $v1 = 0; $v1 < $r1; $v1++) {";
          g.push("for"); h.push(null); q();
          break;
        case 1:
          a += "$tvar $v1 = Math.floor(Math.random() * $r1) + $r1;\n$twhile($v1 > $r1) {\n$t\tconsole.log('Hacker ' + $e1 + '!');\n$t\tvar $v2 = '$v3';\n$t}";
          break;
        case 2:
          a += "$tdo {";
          g.push("do"); h.push(null); q();
          break;
        case 3:
          a += "$twhile (" + l() + ") {";
          g.push("while"); h.push(null); q();
          break;
        case 10:
        case 11:
        case 12:
        case 13:
        case 4:
          if (n > 0) {
            var top = g[g.length - 1];
            var handler = h[h.length - 1];
            var withElse = Math.random() > 0.5;
            switch (top) {
              case "do": a += "$t} while ($e1 != $v2);"; break;
              case "while": a += "$t}"; break;
              case "if": a += withElse ? "$t} else {" : "$t}"; break;
              case "for": a += "$t}"; break;
              case "xhr":
                a += "$t}\n$t" + (handler ? handler.name : "") + ".send($e1);";
                break;
              case "else": a += "$t}"; break;
            }
            if (withElse && top === "if") {
              u = 1; g.pop(); h.pop(); g.push("else"); h.push(null);
            } else {
              g.pop(); h.pop(); n--;
            }
          }
          break;
        case 5:
          a += "$tif (" + l() + ") {";
          g.push("if"); h.push(null); q();
          break;
        case 6:
        case 7:
        case 8:
        case 9:
          if (Math.random() > 0.5) {
            if (Math.random() > 0.5) {
              if (Math.random() > 0.75) {
                var s = "'";
                var len = Math.floor(160 * Math.random()) + 16;
                for (var j = 0; j < len; j++) {
                  var hex = (Math.floor(254 * Math.random()) + 1).toString(16);
                  s += "\\x" + "00".substr(hex.length) + hex;
                  if (j % 10 === 0) s += "' + \n$t'";
                }
                a += "$tvar $v1 = " + (s + "';");
              } else a += "$tvar $v1 = '$s1' + $e1;";
            } else a += "$tvar $v1 = '$s1';";
          } else {
            a = Math.random() > 0.5 ? a + "$tvar $v1 = $r1 * $r2;" : a + "$tvar $v1 = $r1;";
          }
          break;
        case 14:
          a += "$tvar $v1 = new XMLHttpRequest();\n$t$v1.open('POST', 'http://$s1$s2.onion/$s3.php', true);\n$t$v1.send($e1);";
          break;
        case 15: {
          var id = k();
          e.push(id);
          a += "$tvar " + id + " = new XMLHttpRequest();\n$t" + id +
            ".open('POST', 'http://$s1$s2.onion/$s3.php', true);\n$t" + id +
            ".onload = function() {";
          g.push("xhr"); h.push({ name: id }); q();
          break;
        }
      }
      // 替換 $ 佔位符
      var re = /\$[vres]\d{1}/gi;
      var m;
      var guard = 0;
      while ((m = re.exec(a)) !== null && guard++ < 5000) {
        for (var f = 0; f < m.length; f++) {
          var d = m[f];
          var p = k();
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
      a = a.split("$t").join(new Array(Math.max(0, n - u) + 1).join("\t"));
      a += "\n";
      D();
    }

    function D() {
      c(a, function () {
        a = "";
        lastTimer = global.setTimeout(B, 100);
      });
    }

    lastTimer = global.setTimeout(B, 100);

    // stop：中斷所有排程 + flush 殘留
    return function () {
      stopped = true;
      if (lastTimer !== null) global.clearTimeout(lastTimer);
      flush();
    };
  }

  global.startCodeRain = startCodeRain;
})(typeof window !== "undefined" ? window : globalThis);
