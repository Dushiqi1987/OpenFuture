package com.openfuture.cloud.web;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class ApiExceptionHandler {

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> handle(ApiException e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", Map.of("code", e.code(), "message", e.getMessage()));
        return ResponseEntity.status(e.status()).body(body);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> handleBad(IllegalArgumentException e) {
        return ResponseEntity.status(400)
                .body(Map.of("error", Map.of("code", "bad_request", "message", String.valueOf(e.getMessage()))));
    }
}
