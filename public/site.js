// สลับภาษาไทย/อังกฤษ — หน้านี้ถูกอ่านทั้งโดยเพื่อนในกลุ่ม (ไทย) และคนรีวิวแอปของ Whoop/Google (อังกฤษ)
// โหลดด้วย defer จึงรันหลัง DOM พร้อมแล้ว ตั้งค่าได้ทันทีไม่ต้องรอ event
(function () {
  var KEY = "yescal_lang";
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  var lang = saved === "th" || saved === "en"
    ? saved
    : (String(navigator.language || "").toLowerCase().indexOf("th") === 0 ? "th" : "en");

  function apply(next) {
    lang = next;
    document.documentElement.lang = next;
    document.documentElement.setAttribute("data-active", next);
    var btn = document.getElementById("langbtn");
    if (btn) btn.textContent = next === "th" ? "English" : "ภาษาไทย";
  }

  apply(lang);
  var btn = document.getElementById("langbtn");
  if (btn) {
    btn.onclick = function () {
      var next = lang === "th" ? "en" : "th";
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    };
  }
})();
