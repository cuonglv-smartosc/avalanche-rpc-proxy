const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 8888;

// Cấu hình các RPC endpoint của Avalanche
const AVALANCHE_RPC_ENDPOINTS = process.env.AVALANCHE_RPC_ENDPOINTS.split(
  ","
).map((e) => e.trim());

// Theo dõi endpoint hiện tại đang sử dụng
let currentEndpointIndex = 0;

// Lưu trạng thái của các endpoint
const endpointStatus = AVALANCHE_RPC_ENDPOINTS.map(() => ({
  isAvailable: true,
  lastErrorTime: null,
  errorCount: 0,
}));

// Middleware để parse JSON body
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// Middleware để log request body
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl;
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";

  // Log ra console
  console.log(`[${timestamp}] ${method} ${url} from ${ip}`);

  next();
});

// Hàm để kiểm tra nếu response cho thấy đã vượt quá giới hạn request
function isRateLimitExceeded(error) {
  if (!error || !error.response) return false;

  // Kiểm tra HTTP status code
  if (error.response.status === 429) return true;

  // Kiểm tra message từ Alchemy
  const errorMsg = error.response.data?.error?.message || "";
  return (
    errorMsg.includes("exceeded") ||
    errorMsg.includes("rate limit") ||
    errorMsg.includes("too many requests")
  );
}

// Hàm để lấy endpoint khả dụng tiếp theo
function getNextAvailableEndpoint() {
  const startIndex = currentEndpointIndex;

  // Thử tất cả các endpoint theo thứ tự
  for (let i = 0; i < AVALANCHE_RPC_ENDPOINTS.length; i++) {
    currentEndpointIndex = (startIndex + i) % AVALANCHE_RPC_ENDPOINTS.length;

    // Kiểm tra nếu endpoint hiện tại khả dụng
    if (endpointStatus[currentEndpointIndex].isAvailable) {
      return AVALANCHE_RPC_ENDPOINTS[currentEndpointIndex];
    }

    // Kiểm tra nếu endpoint đã hết thời gian "hồi phục" (5 phút)
    const lastErrorTime = endpointStatus[currentEndpointIndex].lastErrorTime;
    if (lastErrorTime && Date.now() - lastErrorTime > 5 * 60 * 1000) {
      endpointStatus[currentEndpointIndex].isAvailable = true;
      endpointStatus[currentEndpointIndex].errorCount = 0;
      return AVALANCHE_RPC_ENDPOINTS[currentEndpointIndex];
    }
  }

  // Nếu tất cả endpoint đều không khả dụng, quay lại endpoint hiện tại
  return AVALANCHE_RPC_ENDPOINTS[startIndex];
}

// Hàm để đánh dấu endpoint hiện tại không khả dụng
function markCurrentEndpointUnavailable() {
  endpointStatus[currentEndpointIndex].isAvailable = false;
  endpointStatus[currentEndpointIndex].lastErrorTime = Date.now();
  endpointStatus[currentEndpointIndex].errorCount++;

  console.log(
    `Endpoint ${currentEndpointIndex} marked unavailable due to rate limit. Switching...`
  );
}

// Hàm xử lý request đến RPC endpoint
async function handleRpcRequest(req, res) {
  let retries = 0;
  const MAX_RETRIES = AVALANCHE_RPC_ENDPOINTS.length;

  console.log(`BODY==== ${JSON.stringify(req.body)}`);

  while (retries < MAX_RETRIES) {
    const currentEndpoint = getNextAvailableEndpoint();

    try {
      console.log(
        `Forwarding request to endpoint ${currentEndpointIndex}: ${currentEndpoint}`
      );

      const response = await axios.post(currentEndpoint, req.body, {
        headers: {
          "Content-Type": "application/json",
        },
      });

      // Log response
      console.log(
        `Response from ${currentEndpoint}: Status ${response.status}`
      );

      // Gửi response về client
      return res.status(response.status).json(response.data);
    } catch (error) {
      if (isRateLimitExceeded(error)) {
        console.log(`Rate limit exceeded for endpoint ${currentEndpointIndex}`);
        markCurrentEndpointUnavailable();
        retries++;
        continue; // Thử endpoint tiếp theo
      } else {
        // Lỗi khác, không phải vượt quá giới hạn request
        console.error(
          `Error with endpoint ${currentEndpointIndex}:`,
          error.message
        );

        // Trả về lỗi từ RPC nếu có
        if (error.response) {
          return res.status(error.response.status).json(error.response.data);
        }

        return res.status(500).json({
          error: {
            message: `RPC Error: ${error.message}`,
            code: -32603,
          },
        });
      }
    }
  }

  // Nếu tất cả các lần thử đều thất bại
  return res.status(500).json({
    error: {
      message: "All RPC endpoints are currently unavailable due to rate limits",
      code: -32603,
    },
  });
}

// Middleware xử lý RPC endpoint cụ thể
app.post("/rpc", async (req, res) => {
  return handleRpcRequest(req, res);
});

// Health check endpoint
app.get("/health", (req, res) => {
  const availableEndpoints = endpointStatus.filter(
    (status) => status.isAvailable
  ).length;
  res.json({
    status: "ok",
    availableEndpoints,
    totalEndpoints: AVALANCHE_RPC_ENDPOINTS.length,
    currentEndpoint: currentEndpointIndex,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});
// Thay thế app.all("*", ...) bằng cách dùng wildcard đúng cú pháp
// Middleware cuối cùng để xử lý các request không khớp
app.use((req, res) => {
  res.status(405).json({
    error: {
      message: "Method not allowed. Use POST for RPC requests.",
      code: -32600,
    },
  });
});

// Khởi động server
app.listen(PORT, () => {
  console.log(`Avalanche RPC middleware running on port ${PORT}`);
  console.log(`Available endpoints: ${AVALANCHE_RPC_ENDPOINTS.length}`);
});
