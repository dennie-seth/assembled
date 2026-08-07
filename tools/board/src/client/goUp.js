export function initGoUpButton(btn, { threshold = 200, scrollSource = window, scrollTarget = window } = {}) {
  btn.hidden = true;
  btn.addEventListener("click", () => scrollTarget.scrollTo({ top: 0, behavior: "smooth" }));
  scrollSource.addEventListener("scroll", () => {
    btn.hidden = (scrollSource.scrollY ?? 0) < threshold;
  });
}
