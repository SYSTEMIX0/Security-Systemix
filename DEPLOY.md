# النشر وتشغيل لوحة التحكم 24 ساعة

لوحة التحكم تعمل **داخل نفس عملية البوت**، فلتكون شغالة 24 ساعة لازم البوت نفسه يشتغل 24 ساعة على جهاز/سيرفر مفتوح دائماً، وله **رابط https عام** (مطلوب لتسجيل الدخول بـ Discord).

## الخيار 0: Render (الأسهل) ⭐

المشروع جاهز لـ Render: ملف `render.yaml` + فحص صحة `/health` + الرابط العام يؤخذ تلقائياً من `RENDER_EXTERNAL_URL`.

1. ارفع المشروع على GitHub (Private).
2. في Render: **New ← Blueprint** ← اختر الريبو. يقرأ `render.yaml` وينشئ الخدمة + القرص الدائم.
3. عبّي المتغيرات لما يطلبها: `TOKEN` و`CLIENT_ID` و`CLIENT_SECRET` و`OWNER_ID` (تقدر تحط أكثر من مالك مفصولين بفاصلة).
4. بعد النشر ياخذك رابط مثل `https://systemix-xxxx.onrender.com` ← أضف `https://systemix-xxxx.onrender.com/auth/callback` في Developer Portal ← OAuth2 ← Redirects.
5. التحديث: أي `git push` ينشر تلقائياً (`autoDeploy`).
6. لو عندك دومين خاص: ضعه في Render ← Custom Domains، وحط `PUBLIC_URL=https://دومينك` في المتغيرات.

**مهم عن الخطط (حسب توثيق Render المتداول، تأكد من صفحة الأسعار الحالية):**
* **الخطة المجانية** تنام بعد 15 دقيقة بدون طلبات (يعني البوت يطلع أوفلاين)، وما فيها **قرص دائم** (الإعدادات والاشتراكات تضيع عند كل نشر). ما تصلح لمتجر. الملف `deploy/render.free.yaml` للتجربة فقط.
* لتشغيل 24 ساعة مع حفظ البيانات استخدم خطة مدفوعة (Starter) مع القرص الدائم، وهذا اللي في `render.yaml`.
* Render ما يقدم تشغيل مجاني دائم، فإذا تبغى مجاني تماماً جرّب الخيار 1 أدناه.

> الأسعار والشروط المجانية عند المنصات **تتغير**، تأكد منها قبل ما تعتمد على أي واحدة. ما في خيار مجاني مضمون للأبد.

## الخيار 1 (الموصى به): سيرفر VPS + دومين مجاني

1. أي VPS صغير (Ubuntu 22/24). بعض المزودين يقدمون باقات مجانية دائمة أو تجريبية؛ ابحث عن "always free VM" وتحقق من الشروط الحالية.
2. دومين مجاني: [DuckDNS](https://www.duckdns.org) ← أنشئ اسم مثل `mybot.duckdns.org` ووجّهه لعنوان IP السيرفر.
3. افتح المنافذ `80` و`443` في جدار حماية المزود.
4. على السيرفر:
   ```bash
   git clone <repo> systemix && cd systemix
   cp .env.example .env && nano .env          # TOKEN, CLIENT_ID, CLIENT_SECRET, OWNER_ID, PUBLIC_URL=https://mybot.duckdns.org
   sudo bash deploy/setup-vps.sh mybot.duckdns.org
   ```
   السكربت يثبّت Node وpm2 وCaddy (HTTPS تلقائي)، ويشغّل البوت ويرجّعه تلقائياً بعد إعادة تشغيل السيرفر.
5. في Developer Portal ← OAuth2 ← Redirects أضف: `https://mybot.duckdns.org/auth/callback`

## الخيار 2: Docker

```bash
cp .env.example .env   # عبّيه
docker compose up -d --build
```
ضع أمامه Caddy أو Nginx أو Cloudflare Tunnel لتوفير https.

## الخيار 3: من جهازك + Cloudflare Tunnel

يعطيك رابط https عام لجهازك، لكن اللوحة تشتغل فقط وجهازك والبوت شغالين. الدومين الثابت يحتاج حساب Cloudflare ودومين.

## بعد النشر

* `PUBLIC_URL` في `.env` لازم يطابق الرابط **بالضبط** (https وبدون `/` في الآخر).
* خذ نسخة احتياطية من مجلد `data/` دورياً (فيه الإعدادات والاشتراكات).
* التحديث: `git pull && npm install && pm2 restart systemix`
* السجلات: `pm2 logs systemix`
