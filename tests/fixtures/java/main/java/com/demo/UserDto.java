package com.demo;

import java.util.List;

public class UserDto {
    private Long id;
    @NotNull
    private String email;
    private List<String> roles = List.of();
    private boolean active = true;

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
}

record Point(int x, int y) {}
