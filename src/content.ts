// =====================================================================
//  單一內容檔 ── 之後更新網站只需要改這個檔案
//  目前內容為「範例佔位」，請全部替換成你的真實資料。
//  注意：content.ts 是唯一需要動的檔案；元件程式碼不用改。
// =====================================================================

export const profile = {
  name: "WOLFHELUO", // Hero 主標題（英文／代號，建議 2~3 個單字內）
  altName: "野格", // 中文名或暱稱
  handle: "CYBER_SPACE", // 代號（出現在導覽 logo 與 footer）
  roleEn: "NETRUNNER // CYBERSECURITY", // Hero 英文職稱/定位
  tagline: "在霓虹與數據的夾縫之間，<br>我的露西終於有了屬於自己的月球。", // Hero 中文標語（可用 <br> 換行）
  bootOs: "NETRUNNER OS", // 載入畫面上的系統名稱
  bootVer: "v0.9.7 // DEEP-DIVE MODULE", // 載入畫面上的版本字樣
};

export const about = {
  headingEn: "ABOUT",
  headingZh: "關於我",
  paragraphs: [
    "你好，我是 <strong>野格</strong>。<br>平常沒事就在城市的資料流裡潛行。<strong>安靜、精準、不留痕跡</strong>。",
    "喜歡潛水、滑雪、徒步、電音、當然還有2077。<br>最近想去跳傘跟阿勒泰滑雪，那個藍調超美。",
	"這裡是我在網路上的一小塊<span class=\"red\">自留地</span>，歡迎四處看看。",
  ],
  stats: [
    { value: "∞", label: "DEEP-DIVE" },
    { value: "24/7", label: "ONLINE" },
    { value: "+++", label: "ICE-BREAK" },
  ],
};

export const skills = {
  headingEn: "SKILLS",
  headingZh: "技能",
  intro: "長期點亮的技能樹：",
  groups: [
    {
      title: "FRONTEND & WEB ARCHITECTURE",
      items: ["React", "TypeScript", "Vite", "Node.js", "CSS / Animations"],
    },
    {
      title: "3D / CREATIVE CODING",
      items: ["Three.js", "React Three Fiber", "GLSL", "Framer Motion"],
    },
    {
      title: "SECURITY / REVERSE",
      items: ["Python", "C", "Reverse Engineering", "Pentesting", "IDA Pro", "Git"],
    },
    {
      title: "LIFE / OTHER",
      items: ["Gaming", "Travel"],
    },
  ],
};

export const projects = {
  headingEn: "PROJECTS",
  headingZh: "作品",
  items: [
    {
      idx: "P-01",
      title: "MOON DREAM",
      zh: "月球夢境",
      desc: "一座以捲動驅動鏡頭的 3D 個人網站，也是你正在看的這個作品本身。",
      tags: ["R3F", "Vite", "GLSL"],
    },
    {
      idx: "P-02",
      title: "GHOST PROTOCOL",
      zh: "幽靈協定",
      desc: "即時協作工具的原型，把零散的團隊資訊流整理成一條乾淨的管線。",
      tags: ["React", "WebSocket", "Node.js"],
    },
    {
      idx: "P-03",
      title: "NEON SIGNAL",
      zh: "霓虹訊號",
      desc: "生成式視覺的實驗場：用 Web Audio 驅動即時粒子畫面，讓聲音看得見。",
      tags: ["Canvas", "Web Audio", "演算法"],
    },
  ],
};

export const contact = {
  headingEn: "CONTACT",
  headingZh: "聯絡",
  line: "歡迎交流技術、找旅遊/吃飯搭子或純聊聊月球",
  note: "——我的頻道永遠開啟。", // 第二行（靠右）
  email: "gm900411@gmail.com", // 主要聯絡信箱
  socials: [
    { label: "GITHUB", href: "https://github.com/wolfheluo" },
    { label: "MAIL", href: "mailto:gm900411@gmail.com" },
    { label: "INSTAGRAM", href: "https://www.instagram.com/wolfheluo/" },
  ],
};
