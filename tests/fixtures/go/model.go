package model

type User struct {
	ID    int64  `json:"id"`
	Email string `json:"email"`
	Roles []string `json:"roles,omitempty"`
}

type Hidden struct {
	secret string
}
