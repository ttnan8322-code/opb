import http from "http";

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, () => console.log(`Health server listening on port ${PORT}`));
