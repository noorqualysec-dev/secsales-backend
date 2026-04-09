import app from "./server.js";

const PORT = Number(process.env.PORT || 8002);
console.log("Starting backend...");
console.log("PORT =", PORT);
console.log("FRONTEND_URL =", process.env.FRONTEND_URL);
console.log("GOOGLE_REDIRECT_URI =", process.env.GOOGLE_REDIRECT_URI);
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});