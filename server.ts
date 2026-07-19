import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { GuidanceMode } from "./types";

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

  // Light in-memory rate limiting to protect resources
  const rateLimits: Record<string, { count: number; resetTime: number }> = {};
  const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
  const MAX_REQUESTS = 15; // 15 requests per minute

  const guidanceLimiter = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
    const now = Date.now();

    if (!rateLimits[ip]) {
      rateLimits[ip] = { count: 1, resetTime: now + RATE_LIMIT_WINDOW };
      return next();
    }

    const limit = rateLimits[ip];
    if (now > limit.resetTime) {
      limit.count = 1;
      limit.resetTime = now + RATE_LIMIT_WINDOW;
      return next();
    }

    limit.count++;
    if (limit.count > MAX_REQUESTS) {
      return res.status(429).json({
        error: "Too many requests. Please try again later.",
        message: "لقد تجاوزت الحد المسموح به من الطلبات. يرجى المحاولة لاحقاً."
      });
    }

    next();
  };

  // Safe internal lazy-initialization of guidance client
  const getGuidanceClient = () => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      throw new Error("Guidance provider key is not configured");
    }
    return new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'rafeeq-platform',
        }
      }
    });
  };

  // Endpoint for the Guidance Assistant
  app.post("/api/guidance", guidanceLimiter, async (req, res) => {
    try {
      const { query, mode, language } = req.body;

      if (!query || !mode) {
        return res.status(400).json({ error: "Missing query or mode parameters" });
      }

      const client = getGuidanceClient();

      const instructions = {
        [GuidanceMode.FATWA]: `أنت مفتي متخصص في مناسك الحج والعمرة. 
          يجب أن تكون إجاباتك مختصرة، مبنية على الدليل، ومستمدة حصرياً من الرئاسة العامة للبحوث العلمية والإفتاء بالمملكة العربية السعودية (alifta.gov.sa).
          إذا كان هناك اختلاف معتبر، فاذكره بإيجاز. اللغة: ${language || 'ar'}.`,
        [GuidanceMode.TRANSLATION]: `أنت مساعد (رفيق) متخصص في التخطيط والبحث عن المواقع في الحرمين الشريفين.
          مهمتك تشمل:
          1. اقتراح مسارات ميسرة تناسب الحالة الصحية للمستخدم (مثل كبار السن، مستخدمي الكراسي المتحركة، أو ذوي الإعاقة).
          2. البحث عن المرافق القريبة (دورات مياه، ماء زمزم، نقاط إسعاف).
          3. التخطيط للرحلة بين المشاعر.
          يجب أن تكون إجاباتك عملية، دقيقة، وتراعي التيسير على ضيوف الرحمن. اللغة: ${language || 'ar'}.`,
        [GuidanceMode.EXPLANATION]: `أنت مرشد (رفيق). اشرح خطوات النسك (مثل صفة العمرة أو الحج) بوضوح وسهولة بناءً على ما ورد في موقع دار الإفتاء (alifta.gov.sa). 
          ركز على الأركان والواجبات والمواقع الجغرافية بدقة، واقترح بدائل ميسرة (مثل الرمي بالإنابة أو استخدام العربات) لمن يعاني من ظروف صحية. اللغة: ${language || 'ar'}.`
      };

      const systemInstruction = (instructions[mode as GuidanceMode] || "أنت رفيق الحرمين.") + " Always cite official sources at the bottom: alifta.gov.sa or alharamain.gov.sa";

      const response = await client.models.generateContent({
        model: "gemini-3.5-flash",
        contents: query,
        config: {
          systemInstruction: systemInstruction,
        }
      });

      res.json({ text: response.text });
    } catch (error: any) {
      console.error("Guidance System API Error:", error?.message);
      res.status(500).json({ 
        error: "Guidance service currently unavailable", 
        message: "عذراً، تعذر الاتصال بمركز الإرشاد حالياً. يرجى المحاولة لاحقاً."
      });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Fallback handler for SPA routing - must be the last middleware
    app.use((req: express.Request, res: express.Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});

