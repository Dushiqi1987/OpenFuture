package com.openfuture.cloud.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 极简鉴权：除公开路径外，都必须带 Authorization: Bearer &lt;jwt&gt;。
 * 不使用 Spring Security 过滤链，避免给一个单体服务引入全套配置。
 */
@Component
public class AuthFilter extends OncePerRequestFilter {
    public static final String UID_ATTR = "openfuture.uid";
    private final JwtService jwt;

    public AuthFilter(JwtService jwt) {
        this.jwt = jwt;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        String p = req.getRequestURI();
        return p.startsWith("/api/auth/")
                || p.startsWith("/api/qr/ticket")
                || p.startsWith("/api/qr/poll")
                || p.startsWith("/api/qr/image/")
                || p.equals("/api/pay/notify")
                || p.startsWith("/v1/")
                || p.startsWith("/api/pay/checkout")
                || p.startsWith("/api/admin/")
                || p.equals("/admin.html")
                || p.equals("/app.html")
                || p.equals("/index.html")
                || p.equals("/")
                || p.startsWith("/h2-console")
                || p.equals("/error")
                || p.equals("/favicon.ico");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String header = req.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            try {
                req.setAttribute(UID_ATTR, jwt.parse(header.substring(7).trim()));
            } catch (Exception ignored) {
                // 落到下面的 401
            }
        }
        if (req.getAttribute(UID_ATTR) == null) {
            res.setStatus(401);
            res.setContentType("application/json;charset=UTF-8");
            res.getWriter().write("{\"error\":{\"code\":\"unauthorized\",\"message\":\"请先登录\"}}");
            return;
        }
        chain.doFilter(req, res);
    }
}
