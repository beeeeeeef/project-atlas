use serde::Serialize;

#[derive(Serialize)]
pub struct User {
    pub id: u64,
    pub email: String,
    roles: Vec<String>,
    #[serde(skip)]
    pub(crate) secret: Option<String>,
}

pub struct Pair(pub i32, pub i32);

impl User {
    pub fn new(id: u64) -> Self { User { id, email: String::new(), roles: vec![], secret: None } }
}
