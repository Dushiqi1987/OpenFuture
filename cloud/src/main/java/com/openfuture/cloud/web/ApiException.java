package com.openfuture.cloud.web;

/** 业务异常：统一映射成 {"error":{"code","message"}} */
public class ApiException extends RuntimeException {
    private final int status;
    private final String code;

    public ApiException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public int status() { return status; }
    public String code() { return code; }

    public static ApiException badRequest(String message) { return new ApiException(400, "bad_request", message); }
    public static ApiException unauthorized(String message) { return new ApiException(401, "unauthorized", message); }
    public static ApiException forbidden(String message) { return new ApiException(403, "forbidden", message); }
    public static ApiException notFound(String message) { return new ApiException(404, "not_found", message); }
    public static ApiException conflict(String message) { return new ApiException(409, "conflict", message); }
    public static ApiException paymentRequired(String message) { return new ApiException(402, "insufficient_balance", message); }
    public static ApiException tooMany(String message) { return new ApiException(429, "too_many_requests", message); }
}
