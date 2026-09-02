// =====================================================================
//  單一內容檔 ── 之後更新網站只需要改這個檔案
//  目前內容為「範例佔位」，請全部替換成你的真實資料。
//  注意：content.ts 是唯一需要動的檔案；元件程式碼不用改。
// =====================================================================

export const profile = {
  name: "YOUR NAME", // Hero 主標題（英文／代號，建議 2~3 個單字內）
  altName: "你的名字", // 中文名或暱稱
  handle: "your_handle", // 代號（出現在導覽 logo 與 footer）
  roleEn: "NETRUNNER // FRONTEND DEVELOPER", // Hero 英文職稱/定位
  tagline: "在霓虹與數據的夾縫之間，我建造屬於自己的月球。", // Hero 中文標語
  bootOs: "NETRUNNER OS", // 載入畫面上的系統名稱
  bootVer: "v0.9.7 // DEEP-DIVE MODULE", // 載入畫面上的版本字樣
};

export const about = {
  headingEn: "ABOUT",
  headingZh: "關於我",
  paragraphs: [
    "你好，我是 <strong>你的名字</strong>。白天在城市的資料流裡潛行，晚上把靈感編譯成介面與畫面。相信好的作品像一次成功的深潛：<strong>安靜、精準、不留痕跡</strong>。",
    "我擅長把冰冷的技術轉譯成人能感受到的體驗——從 3D 視覺、前端工程到細節控的互動設計。這裡是我在網路上的一小塊<span class=\"red\">自留地</span>，歡迎四處看看。",
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
      title: "FRONTEND",
      items: ["React", "TypeScript", "Vite", "CSS / 動畫"],
    },
    {
      title: "3D / CREATIVE CODING",
      items: ["Three.js", "React Three Fiber", "GLSL", "Framer Motion"],
    },
    {
      title: "TOOLS / OTHER",
      items: ["Git", "Node.js", "UI 設計", "效能調校"],
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
  line: "有案子、合作，或只是想聊聊月球——我的頻道永遠暢通。",
  email: "you@example.com", // 主要聯絡信箱
  socials: [
    { label: "GITHUB", href: "https://github.com/" },
    { label: "MAIL", href: "mailto:you@example.com" },
    { label: "LINKEDIN", href: "https://www.linkedin.com/" },
  ],
};
