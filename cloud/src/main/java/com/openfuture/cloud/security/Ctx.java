package com.openfuture.cloud.security;

import jakarta.servlet.http.HttpServletRequest;

public final class Ctx {
    private Ctx() {}

    public static long uid(HttpServletRequest req) {
        Object v = req.getAttribute(AuthFilter.UID_ATTR);
        if (v == null) throw new IllegalStateException("unauthenticated");
        return (Long) v;
    }
}
