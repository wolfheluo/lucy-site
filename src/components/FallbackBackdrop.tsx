// =====================================================================
//  靜態背景：行動裝置 / 無 WebGL / 降低動態偏好時的優雅降級。
// =====================================================================
export default function FallbackBackdrop() {
  return (
    <div className="fallback" aria-hidden="true">
      <div className="stars" />
      <div className="fb-moon" />
    </div>
  );
}
